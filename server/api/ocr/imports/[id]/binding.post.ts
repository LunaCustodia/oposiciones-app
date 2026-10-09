import { defineHandler, HTTPError } from "nitro";
import { getHookByToken, start } from "workflow/api";
import { requireCsrf } from "../../../../../src/server/auth.js";
import { getSafeAvailability } from "../../../../../src/server/connections.js";
import { readExtractionStatus } from "../../../../../src/server/ocr-extractions.js";
import { readImport } from "../../../../../src/server/ocr-imports.js";
import { readInterpretationStatus } from "../../../../../src/server/ocr-interpretation.js";
import { attachBindingRun, bindingHookToken, buildBindingPlan, createBindingStatus, deleteBindingStatus, readBindingStatus, toBindingView } from "../../../../../src/server/ocr-binding.js";
import { ocr05BindingWorkflow } from "../../../../../workflows/ocr05-binding.js";

export default defineHandler(async (event) => {
  const ownerId = requireCsrf(event).sub;
  event.res.headers.set("cache-control", "private, no-store");
  const importId = event.context.params?.id;
  const manifest = importId ? await readImport(ownerId, importId) : null;
  if (!importId || !manifest) throw new HTTPError("Importación no encontrada", { status: 404 });
  const interpretation = await readInterpretationStatus(ownerId, importId);
  if (manifest.state !== "lista" || (await readExtractionStatus(ownerId, importId))?.state !== "completado"
    || !interpretation || !["completado", "revision"].includes(interpretation.state)) {
    throw new HTTPError("OCR-03 y OCR-04 deben estar terminadas", { status: 409 });
  }
  const availability = getSafeAvailability();
  if (!availability.connections.workflow || !availability.connections.gemini) throw new HTTPError("La vinculación está pendiente de configuración", { status: 503 });
  const plan = await buildBindingPlan(ownerId, manifest);
  const initialized = await createBindingStatus(ownerId, importId, plan.fingerprint, plan.refs.length);
  if (["completado", "revision", "error"].includes(initialized.status.state)) return { binding: toBindingView(initialized.status), deduplicated: true };
  const hookToken = bindingHookToken(ownerId, importId, plan.fingerprint);
  try {
    const existing = await getHookByToken(hookToken);
    const current = await readBindingStatus(ownerId, importId) ?? initialized.status;
    const withRun = current.runId ? current : await attachBindingRun(ownerId, importId, existing.runId);
    return { binding: toBindingView(withRun), deduplicated: true };
  } catch {
    try {
      const run = await start(ocr05BindingWorkflow, [ownerId, importId, plan.fingerprint, hookToken], {
        attributes: { importId, state: "pendiente", stage: "en_cola" }, experimental_retention: 0,
      });
      const status = await attachBindingRun(ownerId, importId, run.runId);
      return { binding: toBindingView(status), deduplicated: !initialized.created };
    } catch {
      if (initialized.created) await deleteBindingStatus(ownerId, importId);
      throw new HTTPError("No se pudo iniciar la vinculación", { status: 503 });
    }
  }
});
