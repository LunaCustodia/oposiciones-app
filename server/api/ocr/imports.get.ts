import { defineHandler } from "nitro";
import { requireOcrOwner } from "../../../src/server/auth.js";
import { listOwnerImports, readCurrentImport, toImportView } from "../../../src/server/ocr-imports.js";

export default defineHandler(async (event) => {
  const ownerId = requireOcrOwner(event);
  event.res.headers.set("cache-control", "private, no-store");
  const current = await readCurrentImport(ownerId);
  const imports = await listOwnerImports(ownerId);
  return {
    import: current ? toImportView(current) : imports[0] ? toImportView(imports[0]) : null,
    imports: imports.map(toImportView),
  };
});
