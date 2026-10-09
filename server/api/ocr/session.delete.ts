import { defineHandler } from "nitro";
import { deleteCookie } from "nitro/h3";
import {
  LEGACY_OCR_SESSION_COOKIE,
  OCR_SESSION_COOKIE,
  requireCsrf,
} from "../../../src/server/auth.js";

export default defineHandler((event) => {
  event.res.headers.set("cache-control", "no-store");
  requireCsrf(event);
  deleteCookie(event, OCR_SESSION_COOKIE, { path: "/" });
  deleteCookie(event, LEGACY_OCR_SESSION_COOKIE, { path: "/api/ocr" });
  return { authenticated: false };
});
