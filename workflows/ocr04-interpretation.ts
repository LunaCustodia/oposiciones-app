import { FatalError, RetryableError, createHook, setAttributes } from "workflow";
import type { OcrInterpretationBlockRef, OcrInterpretationWorkflowResult } from "../src/shared/ocr-interpretation.js";
import {
  buildInterpretationPlan,
  finalizeInterpretation,
  isTransientGeminiError,
  markInterpretationBlock,
  markInterpretationFailure,
  processInterpretationBlock,
  setInterpretationStage,
} from "../src/server/ocr-interpretation.js";
import { readImport } from "../src/server/ocr-imports.js";

async function loadBlocks(ownerId: string, importId: string, fingerprint: string, model: string): Promise<OcrInterpretationBlockRef[]> {
  "use step";
  try {
    const manifest = await readImport(ownerId, importId);
    if (!manifest || manifest.state !== "lista") throw new FatalError("La importación no está disponible.");
    const plan = await buildInterpretationPlan(ownerId, manifest, model);
    if (plan.fingerprint !== fingerprint) throw new FatalError("La extracción cambió durante la interpretación.");
    await setInterpretationStage(ownerId, importId, "interpretando_paginas");
    return plan.refs;
  } catch (error) {
    if (error instanceof FatalError || error instanceof RetryableError) throw error;
    if (isTransientGeminiError(error)) throw new RetryableError("El almacenamiento no respondió temporalmente.", { retryAfter: "5s" });
    throw new FatalError("No se pudo preparar la interpretación.");
  }
}
loadBlocks.maxRetries = 2;

async function interpretBlock(ownerId: string, importId: string, fingerprint: string, ref: OcrInterpretationBlockRef, index: number): Promise<void> {
  "use step";
  try {
    await processInterpretationBlock(ownerId, importId, fingerprint, ref);
    await markInterpretationBlock(ownerId, importId, index);
  } catch (error) {
    if (error instanceof RetryableError || error instanceof FatalError) throw error;
    if (isTransientGeminiError(error)) throw new RetryableError("Gemini no respondió temporalmente.", { retryAfter: "5s" });
    throw new FatalError("No se pudo interpretar un bloque documental.");
  }
}
interpretBlock.maxRetries = 2;

async function finish(ownerId: string, importId: string, fingerprint: string, model: string, refs: OcrInterpretationBlockRef[]) {
  "use step";
  try {
    return await finalizeInterpretation(ownerId, importId, fingerprint, model, refs);
  } catch (error) {
    if (error instanceof FatalError || error instanceof RetryableError) throw error;
    if (isTransientGeminiError(error)) throw new RetryableError("El almacenamiento no respondió temporalmente.", { retryAfter: "5s" });
    throw new FatalError("No se pudo consolidar la interpretación.");
  }
}
finish.maxRetries = 2;

async function fail(ownerId: string, importId: string): Promise<void> {
  "use step";
  try {
    await markInterpretationFailure(ownerId, importId);
  } catch (error) {
    if (isTransientGeminiError(error)) throw new RetryableError("El almacenamiento no respondió temporalmente.", { retryAfter: "5s" });
    throw new FatalError("No se pudo registrar el fallo de interpretación.");
  }
}
fail.maxRetries = 1;

export async function ocr04InterpretationWorkflow(
  ownerId: string,
  importId: string,
  fingerprint: string,
  model: string,
  hookToken: string,
): Promise<OcrInterpretationWorkflowResult> {
  "use workflow";
  const ownership = createHook({ token: hookToken, experimental_minRetention: "30d" });
  const conflict = await ownership.getConflict();
  if (conflict) return { kind: "duplicate", importId, ownerRunId: conflict.runId };

  await setAttributes({ importId, state: "procesando", stage: "interpretando_paginas" });
  try {
    const refs = await loadBlocks(ownerId, importId, fingerprint, model);
    for (let index = 0; index < refs.length; index += 1) {
      await interpretBlock(ownerId, importId, fingerprint, refs[index]!, index);
    }
    const finalStatus = await finish(ownerId, importId, fingerprint, model, refs);
    await setAttributes({ state: finalStatus.state, stage: finalStatus.stage });
    return { kind: "completed", importId, state: finalStatus.state };
  } catch {
    await fail(ownerId, importId);
    await setAttributes({ state: "error", stage: "fallo_interpretacion" });
    return { kind: "completed", importId, state: "error" };
  }
}
