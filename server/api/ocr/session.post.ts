import { defineHandler, HTTPError } from "nitro";
import { deleteCookie, setCookie } from "nitro/h3";
import {
  LEGACY_OCR_SESSION_COOKIE,
  OCR_SESSION_COOKIE,
  OCR_SESSION_TTL_SECONDS,
  authenticateOcrUser,
  clearLoginFailures,
  createAuthenticatedSession,
  enforceLoginRateLimit,
  isAuthenticationConfigured,
  recordFailedLogin,
  requireSameOrigin,
} from "../../../src/server/auth.js";

export default defineHandler(async (event) => {
  event.res.headers.set("cache-control", "no-store");
  requireSameOrigin(event);
  const body = await event.req.json().catch(() => null) as { email?: unknown; password?: unknown } | null;
  if (!body || typeof body.email !== "string" || typeof body.password !== "string") {
    throw new HTTPError("Solicitud no válida", { status: 400 });
  }
  if (!isAuthenticationConfigured()) {
    throw new HTTPError("Servicio pendiente de configuración", { status: 503 });
  }

  const attemptKey = enforceLoginRateLimit(event, body.email);
  const ownerId = await authenticateOcrUser(body.email, body.password);
  if (!ownerId) {
    recordFailedLogin(attemptKey);
    throw new HTTPError("Credenciales no válidas", { status: 401 });
  }
  clearLoginFailures(attemptKey);

  const session = createAuthenticatedSession(ownerId, process.env.OCR_SESSION_SECRET!);

  setCookie(
    event,
    OCR_SESSION_COOKIE,
    session.token,
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: OCR_SESSION_TTL_SECONDS,
    },
  );
  deleteCookie(event, LEGACY_OCR_SESSION_COOKIE, { path: "/api/ocr" });
  return { authenticated: true, csrf: session.csrf };
});
