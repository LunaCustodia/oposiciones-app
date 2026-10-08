import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { HTTPError } from "nitro";
import { getCookie, type H3Event } from "nitro/h3";

export const OCR_SESSION_COOKIE = "ocr01_session";
export const OCR_SESSION_TTL_SECONDS = 8 * 60 * 60;

interface SessionPayload {
  sub: string;
  exp: number;
}

interface JobIdentity {
  ownerId: string;
  idempotencyHash: string;
  type: "technical";
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeJson<T>(value: string): T | null {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function hmac(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function authenticateOcrUser(email: string, password: string): string | null {
  const configuredEmail = process.env.OCR_AUTH_EMAIL;
  const configuredPasswordHash = process.env.OCR_AUTH_PASSWORD_SHA256;

  if (!configuredEmail || !configuredPasswordHash || !process.env.OCR_SESSION_SECRET) {
    return null;
  }

  const emailMatches = constantTimeEqual(
    sha256(normalizeEmail(email)),
    sha256(normalizeEmail(configuredEmail)),
  );
  const passwordMatches = constantTimeEqual(sha256(password), configuredPasswordHash.toLowerCase());

  return emailMatches && passwordMatches ? sha256(normalizeEmail(configuredEmail)) : null;
}

export function createSessionToken(
  ownerId: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const payload = encodeJson({ sub: ownerId, exp: nowSeconds + OCR_SESSION_TTL_SECONDS });
  return `${payload}.${hmac(payload, secret)}`;
}

export function verifySessionToken(
  token: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || !constantTimeEqual(signature, hmac(payload, secret))) {
    return null;
  }

  const decoded = decodeJson<SessionPayload>(payload);
  if (!decoded || typeof decoded.sub !== "string" || decoded.exp <= nowSeconds) {
    return null;
  }
  return decoded.sub;
}

export function requireOcrOwner(event: H3Event): string {
  const secret = process.env.OCR_SESSION_SECRET;
  const token = getCookie(event, OCR_SESSION_COOKIE);
  const ownerId = secret && token ? verifySessionToken(token, secret) : null;
  if (!ownerId) {
    throw new HTTPError("Autenticación requerida", { status: 401 });
  }
  return ownerId;
}

export function createTechnicalJobId(ownerId: string, idempotencyKey: string, secret: string): string {
  const identity: JobIdentity = {
    ownerId,
    idempotencyHash: sha256(idempotencyKey),
    type: "technical",
  };
  const payload = encodeJson(identity);
  return `ocr01_${payload}.${hmac(payload, secret)}`;
}

export function verifyTechnicalJobOwner(jobId: string, ownerId: string, secret: string): boolean {
  if (!jobId.startsWith("ocr01_")) return false;
  const [payload, signature, extra] = jobId.slice(6).split(".");
  if (!payload || !signature || extra || !constantTimeEqual(signature, hmac(payload, secret))) {
    return false;
  }
  const decoded = decodeJson<JobIdentity>(payload);
  return decoded?.ownerId === ownerId && decoded.type === "technical";
}

export function jobHookToken(jobId: string): string {
  return `ocr01:${sha256(jobId)}`;
}
