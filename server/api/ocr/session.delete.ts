import { defineHandler } from "nitro";
import { deleteCookie } from "nitro/h3";
import { OCR_SESSION_COOKIE } from "../../../src/server/auth.js";

export default defineHandler((event) => {
  event.res.headers.set("cache-control", "no-store");
  deleteCookie(event, OCR_SESSION_COOKIE, { path: "/api/ocr" });
  return { authenticated: false };
});
