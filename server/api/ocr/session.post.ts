import { defineHandler, HTTPError } from "nitro";
import { setCookie } from "nitro/h3";
import {
  OCR_SESSION_COOKIE,
  OCR_SESSION_TTL_SECONDS,
  authenticateOcrUser,
  createSessionToken,
} from "../../../src/server/auth.js";

export default defineHandler(async (event) => {
  event.res.headers.set("cache-control", "no-store");
  const body = await event.req.json().catch(() => null) as { email?: unknown; password?: unknown } | null;
  if (!body || typeof body.email !== "string" || typeof body.password !== "string") {
    throw new HTTPError("Solicitud no válida", { status: 400 });
  }
  if (!process.env.OCR_AUTH_EMAIL || !process.env.OCR_AUTH_PASSWORD_SHA256 || !process.env.OCR_SESSION_SECRET) {
    throw new HTTPError("Servicio pendiente de configuración", { status: 503 });
  }

  const ownerId = authenticateOcrUser(body.email, body.password);
  if (!ownerId) throw new HTTPError("Credenciales no válidas", { status: 401 });

  setCookie(
    event,
    OCR_SESSION_COOKIE,
    createSessionToken(ownerId, process.env.OCR_SESSION_SECRET),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/api/ocr",
      maxAge: OCR_SESSION_TTL_SECONDS,
    },
  );
  return { authenticated: true };
});
