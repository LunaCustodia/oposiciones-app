import { defineHandler, HTTPError } from "nitro";
import { getHookByToken, start } from "workflow/api";
import { requireCsrf } from "../../../../../src/server/auth.js";
import { getSafeAvailability } from "../../../../../src/server/connections.js";
import {
  attachExtractionRun,
  createExtractionStatus,
  deleteExtractionStatus,
  extractionHookToken,
  readExtractionStatus,
  toExtractionView,
} from "../../../../../src/server/ocr-extractions.js";
import { readImport } from "../../../../../src/server/ocr-imports.js";
import { ocr03ExtractionWorkflow } from "../../../../../workflows/ocr03-extraction.js";

export default defineHandler(async (event) => {
  const ownerId = requireCsrf(event).sub;
  event.res.headers.set("cache-control", "private, no-store");
  const importId = event.context.params?.id;
  const manifest = importId ? await readImport(ownerId, importId) : null;
  if (!importId || !manifest) throw new HTTPError("Importación no encontrada", { status: 404 });
  if (manifest.state !== "lista") throw new HTTPError("La importación todavía no está lista", { status: 409 });

  const availability = getSafeAvailability();
  if (!availability.connections.documentAi || !availability.connections.workflow) {
    throw new HTTPError("La extracción documental está pendiente de configuración", { status: 503 });
  }

  const initialized = await createExtractionStatus(ownerId, manifest);
  if (initialized.status.state === "completado" || initialized.status.state === "revision" || initialized.status.state === "error") {
    return { extraction: toExtractionView(initialized.status), deduplicated: true };
  }

  const hookToken = extractionHookToken(ownerId, importId);
  try {
    const existing = await getHookByToken(hookToken);
    const current = await readExtractionStatus(ownerId, importId) ?? initialized.status;
    const withRun = current.runId ? current : await attachExtractionRun(ownerId, importId, existing.runId);
    return { extraction: toExtractionView(withRun), deduplicated: true };
  } catch {
    try {
      const run = await start(ocr03ExtractionWorkflow, [ownerId, importId, hookToken], {
        attributes: { importId, state: "pendiente", stage: "en_cola" },
      });
      const status = await attachExtractionRun(ownerId, importId, run.runId);
      return { extraction: toExtractionView(status), deduplicated: !initialized.created };
    } catch {
      if (initialized.created) await deleteExtractionStatus(ownerId, importId);
      throw new HTTPError("No se pudo iniciar la extracción documental", { status: 503 });
    }
  }
});
