import { defineHandler, HTTPError } from "nitro";
import { requireOcrOwner } from "../../../../../src/server/auth.js";
import { getReview } from "../../../../../src/server/ocr-review.js";

export default defineHandler(async (event) => {
  const owner = requireOcrOwner(event);
  event.res.headers.set("cache-control", "private, no-store");
  const id = event.context.params?.id;
  if (!id) throw new HTTPError("Importación no encontrada", { status: 404 });
  return { review: await getReview(owner, id) };
});
