import { createHash } from "node:crypto";
import { del, get, head, put } from "@vercel/blob";
import { HTTPError } from "nitro";
import type {
  OcrExtractionFileCache,
  OcrExtractionFileProgress,
  OcrExtractionStatus,
  OcrExtractionView,
  OcrPageExtraction,
} from "../shared/ocr-extraction.js";
import type { OcrImportManifest } from "../shared/ocr-import.js";
import { readImport } from "./ocr-imports.js";

const ROOT = "ocr02/imports";

function importPrefix(ownerId: string, importId: string): string {
  return `${ROOT}/${ownerId}/${importId}`;
}

function extractionPrefix(ownerId: string, importId: string): string {
  return `${importPrefix(ownerId, importId)}/extraction`;
}

function statusPath(ownerId: string, importId: string): string {
  return `${extractionPrefix(ownerId, importId)}/status.json`;
}

function pagePath(ownerId: string, importId: string, fileId: string, pageNumber: number): string {
  return `${extractionPrefix(ownerId, importId)}/pages/${fileId}/${String(pageNumber).padStart(5, "0")}.json`;
}

function fileCachePath(ownerId: string, importId: string, fileId: string): string {
  return `${extractionPrefix(ownerId, importId)}/files/${fileId}.json`;
}

async function readJson<T>(pathname: string): Promise<T | null> {
  const result = await get(pathname, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  try {
    return JSON.parse(await new Response(result.stream).text()) as T;
  } catch {
    return null;
  }
}

async function writeJson(pathname: string, value: unknown, allowOverwrite = true): Promise<void> {
  await put(pathname, JSON.stringify(value), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite,
    cacheControlMaxAge: 60,
    contentType: "application/json",
  });
}

function recalculate(status: OcrExtractionStatus): OcrExtractionStatus {
  return {
    ...status,
    processedFiles: status.files.filter((file) => file.state === "completado" || file.state === "revision" || file.state === "error").length,
    totalPages: status.files.reduce((total, file) => total + (file.totalPages ?? 0), 0),
    processedPages: status.files.reduce((total, file) => total + file.processedPages, 0),
    directPages: status.files.reduce((total, file) => total + file.directPages, 0),
    documentAiPages: status.files.reduce((total, file) => total + file.documentAiPages, 0),
    errorPages: status.files.reduce((total, file) => total + file.errorPages.length, 0),
    updatedAt: new Date().toISOString(),
  };
}

export function extractionHookToken(ownerId: string, importId: string): string {
  return `ocr03:${createHash("sha256").update(`${ownerId}\n${importId}`).digest("hex")}`;
}

export function toExtractionView(status: OcrExtractionStatus): OcrExtractionView {
  const { ownerId: _ownerId, runId: _runId, ...view } = status;
  return view;
}

export async function readExtractionStatus(ownerId: string, importId: string): Promise<OcrExtractionStatus | null> {
  const status = await readJson<OcrExtractionStatus>(statusPath(ownerId, importId));
  return status?.ownerId === ownerId && status.importId === importId ? status : null;
}

export async function createExtractionStatus(ownerId: string, manifest: OcrImportManifest): Promise<{
  status: OcrExtractionStatus;
  created: boolean;
}> {
  const existing = await readExtractionStatus(ownerId, manifest.id);
  if (existing) return { status: existing, created: false };

  const now = new Date().toISOString();
  const status: OcrExtractionStatus = {
    importId: manifest.id,
    ownerId,
    runId: null,
    state: "pendiente",
    stage: "en_cola",
    totalFiles: manifest.files.length,
    processedFiles: 0,
    totalPages: 0,
    processedPages: 0,
    directPages: 0,
    documentAiPages: 0,
    documentAiCalls: 0,
    errorPages: 0,
    files: [...manifest.files]
      .sort((left, right) => left.order - right.order)
      .map((file) => ({
        fileId: file.id,
        originalName: file.originalName,
        order: file.order,
        state: "pendiente",
        totalPages: null,
        processedPages: 0,
        directPages: 0,
        documentAiPages: 0,
        errorPages: [],
        currentPage: null,
      })),
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    error: null,
  };

  try {
    await writeJson(statusPath(ownerId, manifest.id), status, false);
    return { status, created: true };
  } catch {
    const raced = await readExtractionStatus(ownerId, manifest.id);
    if (raced) return { status: raced, created: false };
    throw new HTTPError("No se pudo preparar la extracción", { status: 503 });
  }
}

export async function deleteExtractionStatus(ownerId: string, importId: string): Promise<void> {
  await del(statusPath(ownerId, importId)).catch(() => undefined);
}

export async function updateExtractionStatus(
  ownerId: string,
  importId: string,
  updater: (status: OcrExtractionStatus) => OcrExtractionStatus,
): Promise<OcrExtractionStatus> {
  const current = await readExtractionStatus(ownerId, importId);
  if (!current) throw new Error("extraction_status_not_found");
  const updated = recalculate(updater(current));
  await writeJson(statusPath(ownerId, importId), updated);
  return updated;
}

export async function attachExtractionRun(ownerId: string, importId: string, runId: string): Promise<OcrExtractionStatus> {
  return updateExtractionStatus(ownerId, importId, (status) => ({ ...status, runId }));
}

export async function setExtractionStage(
  ownerId: string,
  importId: string,
  state: OcrExtractionStatus["state"],
  stage: string,
): Promise<OcrExtractionStatus> {
  return updateExtractionStatus(ownerId, importId, (status) => ({ ...status, state, stage, error: null }));
}

export async function updateFileProgress(
  ownerId: string,
  importId: string,
  fileId: string,
  patch: Partial<OcrExtractionFileProgress>,
): Promise<OcrExtractionStatus> {
  return updateExtractionStatus(ownerId, importId, (status) => ({
    ...status,
    files: status.files.map((file) => file.fileId === fileId ? { ...file, ...patch } : file),
  }));
}

export async function recordDocumentAiAttempt(ownerId: string, importId: string): Promise<void> {
  await updateExtractionStatus(ownerId, importId, (status) => ({
    ...status,
    documentAiCalls: status.documentAiCalls + 1,
  }));
}

export async function writePageExtraction(ownerId: string, result: OcrPageExtraction): Promise<void> {
  await writeJson(pagePath(ownerId, result.importId, result.fileId, result.pageNumber), result);
}

export async function readPageExtraction(
  ownerId: string,
  importId: string,
  fileId: string,
  pageNumber: number,
): Promise<OcrPageExtraction | null> {
  return readJson<OcrPageExtraction>(pagePath(ownerId, importId, fileId, pageNumber));
}

export async function refreshFileProgressFromPages(
  ownerId: string,
  importId: string,
  fileId: string,
  pageCount: number,
): Promise<OcrExtractionStatus> {
  const status = await readExtractionStatus(ownerId, importId);
  const file = status?.files.find((candidate) => candidate.fileId === fileId);
  if (!file) throw new Error("extraction_file_progress_not_found");
  let directPages = 0;
  let documentAiPages = 0;
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const result = await readPageExtraction(ownerId, importId, fileId, pageNumber);
    if (result?.method === "direct") directPages += 1;
    if (result?.method === "document_ai" && result.quality.valid) documentAiPages += 1;
  }
  const processedPages = directPages + documentAiPages + file.errorPages.length;
  return updateFileProgress(ownerId, importId, fileId, {
    totalPages: pageCount,
    processedPages,
    directPages,
    documentAiPages,
  });
}

export async function readFileCache(ownerId: string, importId: string, fileId: string): Promise<OcrExtractionFileCache | null> {
  return readJson<OcrExtractionFileCache>(fileCachePath(ownerId, importId, fileId));
}

export async function writeFileCache(ownerId: string, cache: OcrExtractionFileCache): Promise<void> {
  await writeJson(fileCachePath(ownerId, cache.importId, cache.fileId), cache);
}

export async function isFileCacheComplete(ownerId: string, cache: OcrExtractionFileCache): Promise<boolean> {
  for (let pageNumber = 1; pageNumber <= cache.pageCount; pageNumber += 1) {
    try {
      await head(pagePath(ownerId, cache.importId, cache.fileId, pageNumber));
    } catch {
      return false;
    }
  }
  return true;
}

export async function readPrivateImportPdf(ownerId: string, importId: string, fileId: string): Promise<{
  manifest: OcrImportManifest;
  file: OcrImportManifest["files"][number];
  bytes: Uint8Array;
}> {
  const manifest = await readImport(ownerId, importId);
  const file = manifest?.files.find((candidate) => candidate.id === fileId);
  if (!manifest || manifest.state !== "lista" || !file) throw new Error("import_file_not_found");
  const blob = await get(file.pathname, { access: "private", useCache: false });
  if (!blob || blob.statusCode !== 200 || !blob.stream) throw new Error("private_pdf_not_found");
  return { manifest, file, bytes: new Uint8Array(await new Response(blob.stream).arrayBuffer()) };
}

export async function finalizeExtraction(ownerId: string, importId: string): Promise<OcrExtractionStatus> {
  return updateExtractionStatus(ownerId, importId, (status) => {
    const hasErrors = status.files.some((file) => file.errorPages.length > 0 || file.state === "error");
    const now = new Date().toISOString();
    return {
      ...status,
      state: hasErrors ? "revision" : "completado",
      stage: hasErrors ? "requiere_revision" : "extraccion_completada",
      completedAt: now,
      error: hasErrors ? "Una o más páginas no pudieron extraerse correctamente." : null,
    };
  });
}

export async function markExtractionFailure(ownerId: string, importId: string): Promise<void> {
  await updateExtractionStatus(ownerId, importId, (status) => ({
    ...status,
    state: "error",
    stage: "fallo_extraccion",
    completedAt: new Date().toISOString(),
    error: "La extracción documental no pudo completarse.",
  })).catch(() => undefined);
}
