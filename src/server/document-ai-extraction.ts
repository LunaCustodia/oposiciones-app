import { sign } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import type {
  OcrBoundingBox,
  OcrLayoutElement,
  OcrPageExtraction,
  OcrPageQuality,
} from "../shared/ocr-extraction.js";
import { documentAiEndpoint } from "./connections.js";
import { recordDocumentAiAttempt } from "./ocr-extractions.js";

type JsonObject = Record<string, unknown>;

export class DocumentAiExtractionError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "DocumentAiExtractionError";
    this.status = status;
  }
}

function parseGoogleCredentials(): { client_email: string; private_key: string } {
  const raw = process.env.GOOGLE_CLOUD_CREDENTIALS_JSON;
  if (!raw) throw new DocumentAiExtractionError("document_ai_not_configured");
  try {
    const parsed = JSON.parse(raw) as { client_email?: unknown; private_key?: unknown };
    if (typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string") {
      throw new Error("invalid_credentials");
    }
    return { client_email: parsed.client_email, private_key: parsed.private_key };
  } catch {
    throw new DocumentAiExtractionError("document_ai_credentials_invalid");
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
  if (!response.ok) throw new DocumentAiExtractionError("document_ai_auth_failed", response.status);
  const payload = await response.json() as { access_token?: unknown };
  if (typeof payload.access_token !== "string") throw new DocumentAiExtractionError("document_ai_auth_invalid");
  return payload.access_token;
}

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null ? value as JsonObject : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function textFromLayout(text: string, layoutValue: unknown): string {
  const layout = asObject(layoutValue);
  const anchor = asObject(layout.textAnchor);
  return asArray(anchor.textSegments).map((segmentValue) => {
    const segment = asObject(segmentValue);
    const start = numberValue(segment.startIndex);
    const end = numberValue(segment.endIndex);
    return end > start ? text.slice(start, end) : "";
  }).join("").trim();
}

function boundingBoxes(layoutValue: unknown): OcrBoundingBox[] {
  const layout = asObject(layoutValue);
  const poly = asObject(layout.boundingPoly);
  const boxes: OcrBoundingBox[] = [];
  const normalized = asArray(poly.normalizedVertices).map((value) => {
    const point = asObject(value);
    return { x: numberValue(point.x), y: numberValue(point.y) };
  });
  if (normalized.length > 0) boxes.push({ coordinateSystem: "normalized_top_left", vertices: normalized });
  const pixels = asArray(poly.vertices).map((value) => {
    const point = asObject(value);
    return { x: numberValue(point.x), y: numberValue(point.y) };
  });
  if (pixels.length > 0) boxes.push({ coordinateSystem: "pixels_top_left", vertices: pixels });
  return boxes;
}

function normalizeElements(values: unknown, text: string, prefix: string): OcrLayoutElement[] {
  return asArray(values).map((value, order) => {
    const item = asObject(value);
    const layout = asObject(item.layout);
    return {
      id: `${prefix}-${order + 1}`,
      text: textFromLayout(text, layout),
      order,
      confidence: Number.isFinite(Number(layout.confidence)) ? Number(layout.confidence) : null,
      boundingBoxes: boundingBoxes(layout),
    };
  });
}

function illegalRatio(text: string): number {
  if (!text) return 0;
  const illegal = text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/g)?.length ?? 0;
  return illegal / text.length;
}

function qualityForDocumentAi(text: string, tokens: OcrLayoutElement[]): OcrPageQuality {
  const visibleCharacters = text.replace(/\s/g, "").length;
  const wordCount = text.trim() ? text.trim().split(/\s+/u).length : 0;
  const confidences = tokens.map((token) => token.confidence).filter((value): value is number => value !== null);
  const confidence = confidences.length > 0
    ? confidences.reduce((total, value) => total + value, 0) / confidences.length
    : (visibleCharacters > 0 ? 0.5 : 0);
  return {
    valid: visibleCharacters > 0,
    score: Math.max(0, Math.min(1, confidence)),
    visibleCharacters,
    wordCount,
    illegalCharacterRatio: illegalRatio(text),
    singleCharacterTokenRatio: tokens.length > 0
      ? tokens.filter((token) => token.text.trim().length === 1).length / tokens.length
      : 0,
    sourceOrderDiscontinuityRatio: 0,
  };
}

function documentAiIssues(page: JsonObject, quality: OcrPageQuality): string[] {
  const issues: string[] = [];
  if (!quality.valid) issues.push("document_ai_empty_text");
  const scores = asObject(page.imageQualityScores);
  for (const defectValue of asArray(scores.detectedDefects)) {
    const defect = asObject(defectValue);
    const type = typeof defect.type === "string" ? defect.type.toLowerCase() : "quality_defect";
    if (numberValue(defect.confidence) >= 0.5) issues.push(`document_ai_${type}`);
  }
  return issues;
}

async function singlePagePdf(source: Uint8Array, pageIndex: number): Promise<Uint8Array> {
  const sourcePdf = await PDFDocument.load(source, { updateMetadata: false });
  if (pageIndex < 0 || pageIndex >= sourcePdf.getPageCount()) throw new DocumentAiExtractionError("pdf_page_not_found");
  const output = await PDFDocument.create();
  const [page] = await output.copyPages(sourcePdf, [pageIndex]);
  if (!page) throw new DocumentAiExtractionError("pdf_page_not_found");
  output.addPage(page);
  return output.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}

export async function extractPageWithDocumentAi(input: {
  ownerId: string;
  importId: string;
  fileId: string;
  originalName: string;
  fileOrder: number;
  pageNumber: number;
  sourceSha256: string;
  sourcePdf: Uint8Array;
  reason: string;
}): Promise<OcrPageExtraction> {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  const location = process.env.GOOGLE_CLOUD_LOCATION;
  const processorId = process.env.GOOGLE_DOCUMENT_AI_PROCESSOR_ID;
  if (!projectId || !location || !processorId) throw new DocumentAiExtractionError("document_ai_not_configured");

  const pdf = await singlePagePdf(input.sourcePdf, input.pageNumber - 1);
  const accessToken = await getGoogleAccessToken();
  const name = `projects/${projectId}/locations/${location}/processors/${processorId}`;
  await recordDocumentAiAttempt(input.ownerId, input.importId);
  const response = await fetch(`https://${documentAiEndpoint(location)}/v1/${name}:process`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      rawDocument: { content: Buffer.from(pdf).toString("base64"), mimeType: "application/pdf" },
      processOptions: { ocrConfig: { enableNativePdfParsing: false } },
    }),
    signal: AbortSignal.timeout(55_000),
  });
  if (!response.ok) throw new DocumentAiExtractionError("document_ai_page_failed", response.status);

  const payload = await response.json() as { document?: unknown };
  const document = asObject(payload.document);
  const text = typeof document.text === "string" ? document.text : "";
  const page = asObject(asArray(document.pages)[0]);
  const blocks = normalizeElements(page.blocks, text, "block");
  const paragraphs = normalizeElements(page.paragraphs, text, "paragraph");
  const lines = normalizeElements(page.lines, text, "line");
  const tokens = normalizeElements(page.tokens, text, "token");
  const quality = qualityForDocumentAi(text, tokens);
  const issues = documentAiIssues(page, quality);

  return {
    importId: input.importId,
    fileId: input.fileId,
    originalName: input.originalName,
    fileOrder: input.fileOrder,
    pageNumber: input.pageNumber,
    method: "document_ai",
    text,
    blocks,
    paragraphs,
    lines,
    tokens,
    readingOrder: {
      blocks: blocks.map((item) => item.id),
      paragraphs: paragraphs.map((item) => item.id),
      lines: lines.map((item) => item.id),
      tokens: tokens.map((item) => item.id),
    },
    quality,
    documentAiReason: input.reason,
    issues,
    sourceSha256: input.sourceSha256,
    extractedAt: new Date().toISOString(),
  };
}

export function isTransientDocumentAiError(error: unknown): boolean {
  const status = error instanceof DocumentAiExtractionError ? error.status : undefined;
  return status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500)
    || (error instanceof Error && (
      error.name === "TimeoutError"
      || error.name === "AbortError"
      || error.name === "TypeError"
      || /network|fetch failed|socket|connection/iu.test(error.message)
    ));
}
