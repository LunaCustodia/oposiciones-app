import { defineHandler, HTTPError } from "nitro";
import { requireCsrf } from "../../../src/server/auth.js";
import { createImport, toImportView } from "../../../src/server/ocr-imports.js";

export default defineHandler(async (event) => {
  const ownerId = requireCsrf(event).sub;
  event.res.headers.set("cache-control", "private, no-store");
  const body = await event.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    throw new HTTPError("Solicitud de importación no válida", { status: 400 });
  }
  const created = await createImport(ownerId, body);
  return {
    import: toImportView(created.manifest),
    uploads: created.uploads,
  };
});

