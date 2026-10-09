import { sign } from "node:crypto";
import type { DocumentAiProbeSummary } from "../shared/ocr-job.js";

export const CONNECTION_ENV_NAMES = {
  gemini: ["GEMINI_API_KEY", "GEMINI_MODEL"],
  documentAi: [
    "GOOGLE_CLOUD_PROJECT_ID",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_DOCUMENT_AI_PROCESSOR_ID",
    "GOOGLE_CLOUD_CREDENTIALS_JSON",
  ],
  auth: ["OCR_AUTH_EMAIL", "OCR_AUTH_PASSWORD_ARGON2ID", "OCR_SESSION_SECRET"],
} as const;

export interface SafeAvailability {
  status: "available" | "pending_configuration";
  connections: {
    gemini: boolean;
    documentAi: boolean;
    workflow: boolean;
  };
  missing: string[];
}

function missing(names: readonly string[]): string[] {
  return names.filter((name) => !process.env[name]?.trim());
}

export function getSafeAvailability(): SafeAvailability {
  const missingGemini = missing(CONNECTION_ENV_NAMES.gemini);
  const missingDocumentAi = missing(CONNECTION_ENV_NAMES.documentAi);
  const missingWorkflow = process.env.VERCEL
    ? missing(["VERCEL_DEPLOYMENT_ID", "VERCEL_PROJECT_ID"])
    : [];
  const allMissing = [...missingGemini, ...missingDocumentAi, ...missingWorkflow];

  return {
    status: allMissing.length === 0 ? "available" : "pending_configuration",
    connections: {
      gemini: missingGemini.length === 0,
      documentAi: missingDocumentAi.length === 0,
      workflow: missingWorkflow.length === 0,
    },
    missing: allMissing,
  };
}

export function documentAiEndpoint(location: string): string {
  return `${location}-documentai.googleapis.com`;
}

function parseGoogleCredentials(): { client_email: string; private_key: string } {
  const raw = process.env.GOOGLE_CLOUD_CREDENTIALS_JSON;
  if (!raw) throw new Error("pending_configuration");
  try {
    const parsed = JSON.parse(raw) as { client_email?: unknown; private_key?: unknown };
    if (typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string") {
      throw new Error("invalid_credentials");
    }
    return { client_email: parsed.client_email, private_key: parsed.private_key };
  } catch {
    throw new Error("invalid_credentials");
  }
}

async function getGoogleAccessToken(): Promise<string> {
  const credentials = parseGoogleCredentials();
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const assertion = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), credentials.private_key).toString("base64url")}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const error = new Error(`google_auth_http_${response.status}`);
    Object.assign(error, { status: response.status });
    throw error;
  }
  const payload = await response.json() as { access_token?: unknown };
  if (typeof payload.access_token !== "string") throw new Error("invalid_google_auth_response");
  return payload.access_token;
}

export async function callGemini(payload: unknown): Promise<unknown> {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL;
  if (!apiKey || !model) throw new Error("pending_configuration");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(55_000),
    },
  );

  if (!response.ok) {
    const error = new Error(`gemini_http_${response.status}`);
    Object.assign(error, { status: response.status });
    throw error;
  }
  return response.json();
}

function createTechnicalPdf(): Buffer {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    "5 0 obj\n<< /Length 38 >>\nstream\nBT /F1 12 Tf 72 720 Td (OCR-01) Tj ET\nendstream\nendobj\n",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += object;
  }
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

export async function probeGemini(): Promise<void> {
  await callGemini({
    contents: [{ parts: [{ text: "Responde exactamente OCR-01-OK." }] }],
    generationConfig: { maxOutputTokens: 16 },
  });
}

export async function probeDocumentAi(): Promise<DocumentAiProbeSummary> {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  const location = process.env.GOOGLE_CLOUD_LOCATION;
  const processorId = process.env.GOOGLE_DOCUMENT_AI_PROCESSOR_ID;
  if (!projectId || !location || !processorId) throw new Error("pending_configuration");

  const accessToken = await getGoogleAccessToken();
  const name = `projects/${projectId}/locations/${location}/processors/${processorId}`;
  const response = await fetch(`https://${documentAiEndpoint(location)}/v1/${name}:process`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      rawDocument: {
        content: createTechnicalPdf().toString("base64"),
        mimeType: "application/pdf",
      },
    }),
    signal: AbortSignal.timeout(55_000),
  });
  if (!response.ok) {
    const error = new Error(`document_ai_http_${response.status}`);
    Object.assign(error, { status: response.status });
    throw error;
  }
  const payload = await response.json() as {
    document?: {
      text?: unknown;
      pages?: Array<{
        blocks?: unknown[];
        paragraphs?: unknown[];
        tokens?: unknown[];
      }>;
    };
  };
  const text = typeof payload.document?.text === "string" ? payload.document.text : "";
  const pages = Array.isArray(payload.document?.pages) ? payload.document.pages : [];

  return {
    textPresent: text.includes("OCR-01"),
    characterCount: text.length,
    pageCount: pages.length,
    blockCount: pages.reduce((total, page) => total + (Array.isArray(page.blocks) ? page.blocks.length : 0), 0),
    paragraphCount: pages.reduce((total, page) => total + (Array.isArray(page.paragraphs) ? page.paragraphs.length : 0), 0),
    tokenCount: pages.reduce((total, page) => total + (Array.isArray(page.tokens) ? page.tokens.length : 0), 0),
  };
}
