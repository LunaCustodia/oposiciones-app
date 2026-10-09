import { defineHandler, HTTPError } from "nitro";
import { requireOcrOwner } from "../../../../../src/server/auth.js";
import { readImport } from "../../../../../src/server/ocr-imports.js";
import { readBindingStatus, toBindingView } from "../../../../../src/server/ocr-binding.js";

export default defineHandler(async (event) => {
  const ownerId = requireOcrOwner(event);
  event.res.headers.set("cache-control", "private, no-store");
  const importId = event.context.params?.id;
  if (!importId || !await readImport(ownerId, importId)) throw new HTTPError("Importación no encontrada", { status: 404 });
  const status = await readBindingStatus(ownerId, importId);
  return { binding: status ? toBindingView(status) : null };
});
