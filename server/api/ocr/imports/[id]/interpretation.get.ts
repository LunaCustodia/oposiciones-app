import { defineHandler, HTTPError } from "nitro";
import { getRun } from "workflow/api";
import { requireOcrOwner } from "../../../../../src/server/auth.js";
import { readImport } from "../../../../../src/server/ocr-imports.js";
import { markInterpretationFailure, readInterpretationStatus, toInterpretationView } from "../../../../../src/server/ocr-interpretation.js";

export default defineHandler(async (event) => {
  const ownerId = requireOcrOwner(event);
  event.res.headers.set("cache-control", "private, no-store");
  const importId = event.context.params?.id;
  if (!importId || !await readImport(ownerId, importId)) throw new HTTPError("Importación no encontrada", { status: 404 });
  let status = await readInterpretationStatus(ownerId, importId);
  if (status && ["pendiente", "procesando"].includes(status.state)
    && Date.now() - Date.parse(status.updatedAt) > 2 * 60_000) {
    if (!status.runId) {
      await markInterpretationFailure(ownerId, importId, "La interpretación no llegó a iniciarse. Puedes reintentarla.");
    } else {
      try {
        const run = getRun(status.runId);
        const runState = await run.status;
        if (!["pending", "running"].includes(runState)) {
          await markInterpretationFailure(ownerId, importId, "El trabajo terminó sin un resultado válido. Puedes reintentarla.");
        } else if (Date.now() - Date.parse(status.updatedAt) > 15 * 60_000) {
          await run.cancel({ cancelReason: "OCR-04 sin progreso durante 15 minutos" });
          await markInterpretationFailure(ownerId, importId, "La interpretación dejó de avanzar. Puedes reintentarla.");
        }
      } catch { /* Un fallo transitorio de consulta no altera un trabajo activo. */ }
    }
    status = await readInterpretationStatus(ownerId, importId);
  }
  return { interpretation: status ? toInterpretationView(status) : null };
});
