import { defineHandler, HTTPError } from "nitro";
import { getHookByToken, start } from "workflow/api";
import {
  createTechnicalJobId,
  jobHookToken,
  requireCsrf,
} from "../../../src/server/auth.js";
import type { OcrJobContract } from "../../../src/shared/ocr-job.js";
import { ocr01TechnicalWorkflow } from "../../../workflows/ocr01-technical.js";

export default defineHandler(async (event) => {
  const ownerId = requireCsrf(event).sub;
  event.res.headers.set("cache-control", "no-store");
  const secret = process.env.OCR_SESSION_SECRET;
  if (!secret) throw new HTTPError("Servicio pendiente de configuración", { status: 503 });

  const body = await event.req.json().catch(() => null) as {
    type?: unknown;
    idempotencyKey?: unknown;
  } | null;
  const headerKey = event.req.headers.get("idempotency-key");
  const idempotencyKey = typeof body?.idempotencyKey === "string" ? body.idempotencyKey : headerKey;
  if (body?.type !== "technical" || !idempotencyKey || idempotencyKey.length > 128) {
    throw new HTTPError("Trabajo técnico o clave de idempotencia no válidos", { status: 400 });
  }

  const id = createTechnicalJobId(ownerId, idempotencyKey, secret);
  const hookToken = jobHookToken(id);
  const now = new Date().toISOString();
  const job: OcrJobContract = {
    id,
    ownerId,
    privateDocumentRefs: [],
    state: "pendiente",
    stage: "en_cola",
    createdAt: now,
    updatedAt: now,
    error: null,
  };

  try {
    const existing = await getHookByToken(hookToken);
    return { job: { ...job, createdAt: existing.createdAt.toISOString() }, deduplicated: true };
  } catch {
    try {
      await start(ocr01TechnicalWorkflow, [job, hookToken], {
        attributes: { jobKey: hookToken, ownerId, state: job.state, stage: job.stage },
      });
      return { job, deduplicated: false };
    } catch {
      throw new HTTPError("No se pudo iniciar el trabajo técnico", { status: 503 });
    }
  }
});
