import { defineHandler, HTTPError } from "nitro";
import { getHookByToken, start } from "workflow/api";
import { requireCsrf } from "../../../../../src/server/auth.js";
import { getSafeAvailability } from "../../../../../src/server/connections.js";
import { readExtractionStatus } from "../../../../../src/server/ocr-extractions.js";
import { readImport } from "../../../../../src/server/ocr-imports.js";
import {
  attachInterpretationRun,
  buildInterpretationPlan,
  createInterpretationStatus,
  deleteInterpretationStatus,
  interpretationHookToken,
  readInterpretationStatus,
  toInterpretationView,
} from "../../../../../src/server/ocr-interpretation.js";
import { ocr04InterpretationWorkflow } from "../../../../../workflows/ocr04-interpretation.js";

export default defineHandler(async (event) => {
  const ownerId = requireCsrf(event).sub;
  event.res.headers.set("cache-control", "private, no-store");
  const importId = event.context.params?.id;
  const manifest = importId ? await readImport(ownerId, importId) : null;
  if (!importId || !manifest) throw new HTTPError("Importación no encontrada", { status: 404 });
  if (manifest.state !== "lista" || (await readExtractionStatus(ownerId, importId))?.state !== "completado") {
    throw new HTTPError("La extracción OCR-03 debe estar completada", { status: 409 });
  }
  const availability = getSafeAvailability();
  if (!availability.connections.gemini || !availability.connections.workflow) {
    throw new HTTPError("La interpretación está pendiente de configuración", { status: 503 });
  }
  const model = process.env.GEMINI_MODEL!;
  const plan = await buildInterpretationPlan(ownerId, manifest, model);
  const initialized = await createInterpretationStatus(ownerId, importId, plan.fingerprint, model, plan.refs.length);
  if (["completado", "revision"].includes(initialized.status.state)) {
    return { interpretation: toInterpretationView(initialized.status), deduplicated: true };
  }
  const hookToken = interpretationHookToken(ownerId, importId, plan.fingerprint, initialized.status.attempt ?? 1);
  try {
    const existing = await getHookByToken(hookToken);
    const current = await readInterpretationStatus(ownerId, importId) ?? initialized.status;
    const withRun = current.runId ? current : await attachInterpretationRun(ownerId, importId, existing.runId);
    return { interpretation: toInterpretationView(withRun), deduplicated: true };
  } catch {
    try {
      const run = await start(ocr04InterpretationWorkflow, [ownerId, importId, plan.fingerprint, model, hookToken], {
        attributes: { importId, state: "pendiente", stage: "en_cola" },
      });
      const status = await attachInterpretationRun(ownerId, importId, run.runId);
      return { interpretation: toInterpretationView(status), deduplicated: !initialized.created };
    } catch {
      if (initialized.created) await deleteInterpretationStatus(ownerId, importId);
      throw new HTTPError("No se pudo iniciar la interpretación", { status: 503 });
    }
  }
});
