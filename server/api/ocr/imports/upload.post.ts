import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { defineHandler, HTTPError } from "nitro";
import { requireCsrf } from "../../../../src/server/auth.js";
import {
  OCR_IMPORT_MAX_FILE_SIZE,
  readImport,
} from "../../../../src/server/ocr-imports.js";

export default defineHandler(async (event) => {
  event.res.headers.set("cache-control", "private, no-store");
  const body = await event.req.json().catch(() => null) as HandleUploadBody | null;
  if (!body) throw new HTTPError("Solicitud de subida no válida", { status: 400 });

  return handleUpload({
    request: event.req,
    body,
    onBeforeGenerateToken: async (pathname, clientPayload) => {
      const ownerId = requireCsrf(event).sub;
      type UploadPayload = { importId?: unknown; fileId?: unknown };
      let payload: UploadPayload | null = null;
      try {
        payload = JSON.parse(clientPayload || "null") as UploadPayload | null;
      } catch {
        payload = null;
      }
      if (
        !payload
        || typeof payload.importId !== "string"
        || typeof payload.fileId !== "string"
      ) {
        throw new HTTPError("Referencia de subida no válida", { status: 400 });
      }

      const manifest = await readImport(ownerId, payload.importId);
      const file = manifest?.files.find((item) => item.id === payload.fileId);
      if (!manifest || !file || manifest.state === "lista" || file.pathname !== pathname) {
        throw new HTTPError("Archivo no autorizado", { status: 404 });
      }

      return {
        allowedContentTypes: ["application/pdf"],
        maximumSizeInBytes: Math.min(file.size, OCR_IMPORT_MAX_FILE_SIZE),
        validUntil: Date.now() + 15 * 60 * 1_000,
        addRandomSuffix: false,
        allowOverwrite: false,
        cacheControlMaxAge: 60,
      };
    },
  });
});
