import { defineHandler, HTTPError } from "nitro";
import { getHookByToken, getRun } from "workflow/api";
import {
  jobHookToken,
  requireOcrOwner,
  verifyTechnicalJobOwner,
} from "../../../../src/server/auth.js";
import type { OcrJobContract, TechnicalWorkflowResult } from "../../../../src/shared/ocr-job.js";

export default defineHandler(async (event) => {
  const ownerId = requireOcrOwner(event);
  event.res.headers.set("cache-control", "no-store");
  const id = event.context.params?.id;
  const secret = process.env.OCR_SESSION_SECRET;
  if (!id || !secret || !verifyTechnicalJobOwner(id, ownerId, secret)) {
    throw new HTTPError("Trabajo no encontrado", { status: 404 });
  }

  let hook;
  try {
    hook = await getHookByToken(jobHookToken(id));
  } catch {
    const now = new Date().toISOString();
    return {
      job: {
        id,
        ownerId,
        privateDocumentRefs: [],
        state: "pendiente",
        stage: "en_cola",
        createdAt: now,
        updatedAt: now,
        error: null,
      } satisfies OcrJobContract,
    };
  }

  const run = getRun<TechnicalWorkflowResult>(hook.runId);
  const status = String(await run.status);
  if (status === "completed") {
    const output = await run.returnValue;
    if (output.kind === "completed" && output.result) return output;
    return {
      job: { ...output.job, state: "procesando", stage: "deduplicado" },
      ownerRunId: output.ownerRunId,
    };
  }
  if (status === "failed" || status === "cancelled") {
    return {
      job: {
        id,
        ownerId,
        privateDocumentRefs: [],
        state: "error",
        stage: "comprobacion_tecnica",
        createdAt: hook.createdAt.toISOString(),
        updatedAt: new Date().toISOString(),
        error: "El trabajo técnico no pudo completarse.",
      } satisfies OcrJobContract,
    };
  }

  return {
    job: {
      id,
      ownerId,
      privateDocumentRefs: [],
      state: status === "pending" ? "pendiente" : "procesando",
      stage: status === "pending" ? "en_cola" : "comprobacion_tecnica",
      createdAt: hook.createdAt.toISOString(),
      updatedAt: new Date().toISOString(),
      error: null,
    } satisfies OcrJobContract,
  };
});
