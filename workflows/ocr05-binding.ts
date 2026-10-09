import { FatalError, RetryableError, createHook, setAttributes } from "workflow";
import {
  buildBindingPlan, finalizeBinding, markBindingFailure, markBindingPage,
  processBindingPage, setBindingStage, type BindingPageRef,
} from "../src/server/ocr-binding.js";
import { isTransientGeminiError } from "../src/server/ocr-interpretation.js";
import { readImport } from "../src/server/ocr-imports.js";

async function prepare(ownerId: string, importId: string, fingerprint: string): Promise<BindingPageRef[]> {
  "use step";
  try {
    const manifest = await readImport(ownerId, importId);
    if (!manifest || manifest.state !== "lista") throw new FatalError("Importación no disponible.");
    const plan = await buildBindingPlan(ownerId, manifest);
    if (plan.fingerprint !== fingerprint) throw new FatalError("La interpretación cambió.");
    await setBindingStage(ownerId, importId, "leyendo_plantillas");
    return plan.refs;
  } catch (error) {
    if (error instanceof FatalError || error instanceof RetryableError) throw error;
    if (isTransientGeminiError(error)) throw new RetryableError("Almacenamiento temporalmente no disponible.", { retryAfter: "5s" });
    throw new FatalError("No se pudo preparar la vinculación.");
  }
}
prepare.maxRetries = 2;

async function readPage(ownerId: string, importId: string, fingerprint: string, ref: BindingPageRef, index: number): Promise<void> {
  "use step";
  try {
    await processBindingPage(ownerId, importId, fingerprint, ref);
    await markBindingPage(ownerId, importId, index);
  } catch (error) {
    if (error instanceof FatalError || error instanceof RetryableError) throw error;
    if (isTransientGeminiError(error)) throw new RetryableError("Servicio temporalmente no disponible.", { retryAfter: "5s" });
    throw new FatalError("No se pudo leer una página de plantilla.");
  }
}
readPage.maxRetries = 2;

async function finish(ownerId: string, importId: string, fingerprint: string, refs: BindingPageRef[]) {
  "use step";
  try { return await finalizeBinding(ownerId, importId, fingerprint, refs); }
  catch (error) {
    if (error instanceof FatalError || error instanceof RetryableError) throw error;
    if (isTransientGeminiError(error)) throw new RetryableError("Almacenamiento temporalmente no disponible.", { retryAfter: "5s" });
    throw new FatalError("No se pudo consolidar la vinculación.");
  }
}
finish.maxRetries = 2;

async function fail(ownerId: string, importId: string): Promise<void> {
  "use step";
  await markBindingFailure(ownerId, importId);
}
fail.maxRetries = 1;

export async function ocr05BindingWorkflow(ownerId: string, importId: string, fingerprint: string, hookToken: string) {
  "use workflow";
  const ownership = createHook({ token: hookToken, experimental_minRetention: "30d" });
  const conflict = await ownership.getConflict();
  if (conflict) return { kind: "duplicate", importId, ownerRunId: conflict.runId };
  await setAttributes({ importId, state: "procesando", stage: "leyendo_plantillas" });
  try {
    const refs = await prepare(ownerId, importId, fingerprint);
    for (let index = 0; index < refs.length; index += 1) await readPage(ownerId, importId, fingerprint, refs[index]!, index);
    const status = await finish(ownerId, importId, fingerprint, refs);
    await setAttributes({ state: status.state, stage: status.stage });
    return { kind: "completed", importId, state: status.state };
  } catch {
    await fail(ownerId, importId);
    await setAttributes({ state: "error", stage: "fallo_vinculacion" });
    return { kind: "completed", importId, state: "error" };
  }
}
