import { defineHandler, HTTPError } from "nitro";
import { requireCsrf } from "../../../../../src/server/auth.js";
import { selectImport, toImportView } from "../../../../../src/server/ocr-imports.js";

export default defineHandler(async (event) => {
  const ownerId = requireCsrf(event).sub;
  event.res.headers.set("cache-control", "private, no-store");
  const importId = event.context.params?.id;
  if (!importId) throw new HTTPError("Importación no encontrada", { status: 404 });
  const manifest = await selectImport(ownerId, importId);
  return { import: toImportView(manifest) };
});
