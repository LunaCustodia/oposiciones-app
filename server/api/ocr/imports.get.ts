import { defineHandler } from "nitro";
import { requireOcrOwner } from "../../../src/server/auth.js";
import { readCurrentImport, toImportView } from "../../../src/server/ocr-imports.js";

export default defineHandler(async (event) => {
  const ownerId = requireOcrOwner(event);
  event.res.headers.set("cache-control", "private, no-store");
  const current = await readCurrentImport(ownerId);
  return { import: current ? toImportView(current) : null };
});

