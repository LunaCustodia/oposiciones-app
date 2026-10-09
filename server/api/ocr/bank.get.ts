import { defineHandler } from "nitro";
import { requireOcrOwner } from "../../../src/server/auth.js";
import { listOwnedOcr06Exams } from "../../../src/server/ocr-review-bank.js";

export default defineHandler(async (event) => {
  const owner = requireOcrOwner(event);
  event.res.headers.set("cache-control", "private, no-store");
  return { exams: await listOwnedOcr06Exams(owner) };
});
