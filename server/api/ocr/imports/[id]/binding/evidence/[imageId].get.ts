import { defineHandler, HTTPError } from "nitro";
import { requireOcrOwner } from "../../../../../../../src/server/auth.js";
import { readImport } from "../../../../../../../src/server/ocr-imports.js";
import { readBindingEvidence } from "../../../../../../../src/server/ocr-binding.js";

export default defineHandler(async (event) => {
  const ownerId = requireOcrOwner(event);
  const importId = event.context.params?.id;
  const imageId = event.context.params?.imageId;
  if (!importId || !imageId || !await readImport(ownerId, importId)) throw new HTTPError("Evidencia no encontrada", { status: 404 });
  const stream = await readBindingEvidence(ownerId, importId, imageId);
  if (!stream) throw new HTTPError("Evidencia no encontrada", { status: 404 });
  return new Response(stream, { headers: { "content-type": "image/png", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
});
