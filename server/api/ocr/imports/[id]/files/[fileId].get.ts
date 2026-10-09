import { get } from "@vercel/blob";
import { defineHandler, HTTPError } from "nitro";
import { requireOcrOwner } from "../../../../../../src/server/auth.js";
import { requireImportFile } from "../../../../../../src/server/ocr-imports.js";

function safeAsciiFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "documento.pdf";
}

export default defineHandler(async (event) => {
  const ownerId = requireOcrOwner(event);
  const id = event.context.params?.id;
  const fileId = event.context.params?.fileId;
  if (!id || !fileId) throw new HTTPError("Archivo no encontrado", { status: 404 });

  const { file } = await requireImportFile(ownerId, id, fileId);
  const result = await get(file.pathname, { access: "private" });
  if (!result || result.statusCode !== 200 || !result.stream) {
    throw new HTTPError("Archivo no encontrado", { status: 404 });
  }

  return new Response(result.stream, {
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${safeAsciiFilename(file.originalName)}"; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
      "x-content-type-options": "nosniff",
    },
  });
});

