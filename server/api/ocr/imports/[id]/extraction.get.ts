import { defineHandler, HTTPError } from "nitro";
import { requireOcrOwner } from "../../../../../src/server/auth.js";
import { readExtractionStatus, toExtractionView } from "../../../../../src/server/ocr-extractions.js";
import { readImport } from "../../../../../src/server/ocr-imports.js";

export default defineHandler(async (event) => {
  const ownerId = requireOcrOwner(event);
  event.res.headers.set("cache-control", "private, no-store");
  const importId = event.context.params?.id;
  if (!importId || !await readImport(ownerId, importId)) {
    throw new HTTPError("Importación no encontrada", { status: 404 });
  }
  const status = await readExtractionStatus(ownerId, importId);
  return { extraction: status ? toExtractionView(status) : null };
});
