import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { verify } from "@node-rs/argon2";
import { HTTPError } from "nitro";
import { getCookie, type H3Event } from "nitro/h3";

export const OCR_SESSION_COOKIE = "opos_session";
export const LEGACY_OCR_SESSION_COOKIE = "ocr01_session";
export const OCR_SESSION_TTL_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1_000;
const LOGIN_MAX_FAILURES = 5;

export interface SessionPayload {
  sub: string;
  exp: number;
  csrf: string;
}

interface JobIdentity {
  ownerId: string;
  idempotencyHash: string;
  type: "technical";
}

interface LoginAttempt {
  failures: number;
  resetAt: number;
}

const loginAttempts = new Map<string, LoginAttempt>();

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

export function isAuthenticationConfigured(): boolean {
  return Boolean(
    process.env.OCR_AUTH_EMAIL
    && process.env.OCR_AUTH_PASSWORD_ARGON2ID
    && process.env.OCR_SESSION_SECRET,
  );
}

export async function authenticateOcrUser(email: string, password: string): Promise<string | null> {
  const configuredEmail = process.env.OCR_AUTH_EMAIL;
  const configuredPasswordHash = process.env.OCR_AUTH_PASSWORD_ARGON2ID;

  if (!configuredEmail || !configuredPasswordHash || !process.env.OCR_SESSION_SECRET) {
    return null;
  }

  const emailMatches = constantTimeEqual(
    sha256(normalizeEmail(email)),
    sha256(normalizeEmail(configuredEmail)),
  );
  const passwordMatches = await verify(configuredPasswordHash, password).catch(() => false);

  return emailMatches && passwordMatches ? sha256(normalizeEmail(configuredEmail)) : null;
}

export function createSessionToken(
  ownerId: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  csrf = randomBytes(32).toString("base64url"),
): string {
  const payload = encodeJson({ sub: ownerId, exp: nowSeconds + OCR_SESSION_TTL_SECONDS, csrf });
  return `${payload}.${hmac(payload, secret)}`;
}

export function createAuthenticatedSession(ownerId: string, secret: string): { token: string; csrf: string } {
  const csrf = randomBytes(32).toString("base64url");
  return { token: createSessionToken(ownerId, secret, undefined, csrf), csrf };
}

export function verifySessionToken(
  token: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): SessionPayload | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || !constantTimeEqual(signature, hmac(payload, secret))) {
    return null;
  }

  const decoded = decodeJson<SessionPayload>(payload);
  if (
    !decoded
    || typeof decoded.sub !== "string"
    || typeof decoded.csrf !== "string"
    || decoded.csrf.length < 32
    || decoded.exp <= nowSeconds
  ) {
    return null;
  }
  return decoded;
}

export function getAuthenticatedSession(event: H3Event): SessionPayload | null {
  const secret = process.env.OCR_SESSION_SECRET;
  const token = getCookie(event, OCR_SESSION_COOKIE);
  return secret && token ? verifySessionToken(token, secret) : null;
}

export function requireOcrOwner(event: H3Event): string {
  const session = getAuthenticatedSession(event);
  if (!session) {
    throw new HTTPError("Autenticación requerida", { status: 401 });
  }
  return session.sub;
}

export function requireSameOrigin(event: H3Event): void {
  const origin = event.req.headers.get("origin");
  const requestOrigin = new URL(event.req.url).origin;
  const fetchSite = event.req.headers.get("sec-fetch-site");
  if (origin !== requestOrigin || (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")) {
    throw new HTTPError("Origen no permitido", { status: 403 });
  }
}

export function requireCsrf(event: H3Event): SessionPayload {
  requireSameOrigin(event);
  const session = getAuthenticatedSession(event);
  const supplied = event.req.headers.get("x-csrf-token");
  if (!session) throw new HTTPError("Autenticación requerida", { status: 401 });
  if (!supplied || !constantTimeEqual(supplied, session.csrf)) {
    throw new HTTPError("Protección CSRF no válida", { status: 403 });
  }
  return session;
}

function loginAttemptKey(event: H3Event, email: string): string {
  const forwarded = event.req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || event.req.headers.get("x-real-ip") || "unknown";
  const secret = process.env.OCR_SESSION_SECRET || "unconfigured";
  return hmac(`${ip}\n${normalizeEmail(email)}`, secret);
}

export function enforceLoginRateLimit(event: H3Event, email: string, now = Date.now()): string {
  const key = loginAttemptKey(event, email);
  const attempt = loginAttempts.get(key);
  if (!attempt || attempt.resetAt <= now) {
    loginAttempts.set(key, { failures: 0, resetAt: now + LOGIN_WINDOW_MS });
    return key;
  }
  if (attempt.failures >= LOGIN_MAX_FAILURES) {
    const retryAfter = Math.max(1, Math.ceil((attempt.resetAt - now) / 1_000));
    event.res.headers.set("retry-after", String(retryAfter));
    throw new HTTPError("Demasiados intentos. Inténtalo más tarde.", { status: 429 });
  }
  return key;
}

export function recordFailedLogin(key: string): void {
  const attempt = loginAttempts.get(key);
  if (attempt) attempt.failures += 1;
}

export function clearLoginFailures(key: string): void {
  loginAttempts.delete(key);
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
