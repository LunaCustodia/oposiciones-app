import { defineHandler, HTTPError } from "nitro";
import { requireOcrOwner } from "../../../../../../src/server/auth.js";
import { readImport } from "../../../../../../src/server/ocr-imports.js";
import { readInterpretationResult } from "../../../../../../src/server/ocr-interpretation.js";

export default defineHandler(async (event) => {
  const ownerId = requireOcrOwner(event);
  event.res.headers.set("cache-control", "private, no-store");
  const importId = event.context.params?.id;
  if (!importId || !await readImport(ownerId, importId)) throw new HTTPError("Importación no encontrada", { status: 404 });
  const result = await readInterpretationResult(ownerId, importId);
  if (!result) throw new HTTPError("Interpretación no disponible", { status: 404 });
  return { result };
});
