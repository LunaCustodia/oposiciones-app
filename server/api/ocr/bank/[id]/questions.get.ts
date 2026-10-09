import { defineHandler, HTTPError } from "nitro";
import { requireOcrOwner } from "../../../../../src/server/auth.js";
import { listOwnedOcr06Questions } from "../../../../../src/server/ocr-review-bank.js";

export default defineHandler(async (event) => {
  const owner = requireOcrOwner(event);
  event.res.headers.set("cache-control", "private, no-store");
  const id = event.context.params?.id;
  if (!id) throw new HTTPError("Examen no encontrado", { status: 404 });
  return { questions: await listOwnedOcr06Questions(owner, id) };
});
