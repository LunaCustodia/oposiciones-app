import { defineHandler, HTTPError } from "nitro";
import { requireCsrf } from "../../../../../../src/server/auth.js";
import { confirmReviewedImport } from "../../../../../../src/server/ocr-review-import.js";

export default defineHandler(async (event) => {
  const owner = requireCsrf(event).sub;
  event.res.headers.set("cache-control", "private, no-store");
  const id = event.context.params?.id;
  if (!id) throw new HTTPError("Importación no encontrada", { status: 404 });
  return { imported: await confirmReviewedImport(owner, id) };
});
