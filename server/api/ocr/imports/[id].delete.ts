import { defineHandler, HTTPError } from "nitro";
import { requireCsrf } from "../../../../src/server/auth.js";
import { readExtractionStatus } from "../../../../src/server/ocr-extractions.js";
import { cancelImport } from "../../../../src/server/ocr-imports.js";

export default defineHandler(async (event) => {
  const ownerId = requireCsrf(event).sub;
  event.res.headers.set("cache-control", "private, no-store");
  const id = event.context.params?.id;
  if (!id) throw new HTTPError("Importación no encontrada", { status: 404 });
  const extraction = await readExtractionStatus(ownerId, id);
  if (extraction?.state === "pendiente" || extraction?.state === "procesando") {
    throw new HTTPError("No se puede cancelar mientras la extracción está en curso", { status: 409 });
  }
  await cancelImport(ownerId, id);
  return { cancelled: true };
});
