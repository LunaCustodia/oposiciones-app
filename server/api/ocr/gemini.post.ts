import { defineHandler, HTTPError } from "nitro";
import { requireCsrf } from "../../../src/server/auth.js";
import { callGemini } from "../../../src/server/connections.js";

const MAX_BODY_BYTES = 4_000_000;

export default defineHandler(async (event) => {
  requireCsrf(event);
  event.res.headers.set("cache-control", "no-store");

  const declaredLength = Number(event.req.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    throw new HTTPError("La solicitud supera el límite del servidor", { status: 413 });
  }

  const payload = await event.req.json().catch(() => null) as {
    contents?: unknown;
    generationConfig?: unknown;
  } | null;
  if (!payload || !Array.isArray(payload.contents)) {
    throw new HTTPError("Solicitud no válida", { status: 400 });
  }
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_BODY_BYTES) {
    throw new HTTPError("La solicitud supera el límite del servidor", { status: 413 });
  }

  try {
    return await callGemini(payload);
  } catch (error) {
    if (error instanceof Error && error.message === "pending_configuration") {
      throw new HTTPError("Gemini pendiente de configuración", { status: 503 });
    }
    throw new HTTPError("Gemini no está disponible", { status: 502 });
  }
});
