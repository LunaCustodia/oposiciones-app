import { defineHandler, HTTPError } from "nitro";
import { requireCsrf } from "../../../../../src/server/auth.js";
import { completeImport, toImportView } from "../../../../../src/server/ocr-imports.js";

export default defineHandler(async (event) => {
  const ownerId = requireCsrf(event).sub;
  event.res.headers.set("cache-control", "private, no-store");
  const id = event.context.params?.id;
  if (!id) throw new HTTPError("Importación no encontrada", { status: 404 });
  return { import: toImportView(await completeImport(ownerId, id)) };
});

