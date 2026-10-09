import { randomUUID } from "node:crypto";
import { del, get, head, list, put } from "@vercel/blob";
import { HTTPError } from "nitro";
import {
  OCR_IMPORT_FILE_TYPES,
  type OcrImportFile,
  type OcrImportFileType,
  type OcrImportManifest,
  type OcrImportMetadata,
  type OcrImportView,
} from "../shared/ocr-import.js";

const ROOT = "ocr02/imports";
const MAX_FILES = 20;
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const PDF_SIGNATURE = "%PDF-";

interface CreateImportFileInput {
  clientId?: unknown;
  originalName?: unknown;
  size?: unknown;
  mimeType?: unknown;
  type?: unknown;
  lastModified?: unknown;
}

interface CreateImportInput {
  metadata?: unknown;
  files?: unknown;
}

interface CurrentPointer {
  importId: string;
}

function ensureBlobConfigured(): void {
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) {
    throw new HTTPError("El almacenamiento privado está pendiente de configuración", { status: 503 });
  }
}

function ownerPrefix(ownerId: string): string {
  return `${ROOT}/${ownerId}`;
}

function importPrefix(ownerId: string, importId: string): string {
  return `${ownerPrefix(ownerId)}/${importId}`;
}

function currentPath(ownerId: string): string {
  return `${ownerPrefix(ownerId)}/current.json`;
}

function manifestPath(ownerId: string, importId: string): string {
  return `${importPrefix(ownerId, importId)}/manifest.json`;
}

async function readJson<T>(pathname: string): Promise<T | null> {
  ensureBlobConfigured();
  const result = await get(pathname, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  try {
    return JSON.parse(await new Response(result.stream).text()) as T;
  } catch {
    return null;
  }
}

async function writeJson(pathname: string, value: unknown): Promise<void> {
  ensureBlobConfigured();
  await put(pathname, JSON.stringify(value), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60,
    contentType: "application/json",
  });
}

function optionalText(value: unknown, name: string, maxLength: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new HTTPError(`${name} no es válido`, { status: 400 });
  }
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    throw new HTTPError(`${name} es demasiado largo`, { status: 400 });
  }
  return normalized;
}

function normalizeMetadata(value: unknown): OcrImportMetadata {
  const input = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
  let año: number | null = null;
  if (input.año !== null && input.año !== undefined && input.año !== "") {
    const parsed = typeof input.año === "number" ? input.año : Number(input.año);
    if (!Number.isInteger(parsed) || parsed < 1000 || parsed > 9999) {
      throw new HTTPError("El año no es válido", { status: 400 });
    }
    año = parsed;
  }
  return {
    titulo: optionalText(input.titulo, "El título", 200),
    año,
    organismo: optionalText(input.organismo, "El organismo", 200),
    categoria: optionalText(input.categoria, "La categoría", 100),
  };
}

function normalizeFiles(ownerId: string, importId: string, value: unknown): {
  files: OcrImportFile[];
  clientIds: string[];
} {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILES) {
    throw new HTTPError(`Selecciona entre 1 y ${MAX_FILES} archivos PDF`, { status: 400 });
  }

  const fingerprints = new Set<string>();
  const clientIds = new Set<string>();
  const files = value.map((raw, order) => {
    const input = raw as CreateImportFileInput;
    if (
      typeof input.clientId !== "string"
      || input.clientId.length < 1
      || input.clientId.length > 300
      || clientIds.has(input.clientId)
    ) {
      throw new HTTPError("La referencia de un archivo no es válida", { status: 400 });
    }
    clientIds.add(input.clientId);

    if (
      typeof input.originalName !== "string"
      || input.originalName.length < 1
      || input.originalName.length > 255
      || !input.originalName.toLowerCase().endsWith(".pdf")
      || (input.mimeType !== "application/pdf" && input.mimeType !== "")
    ) {
      throw new HTTPError("Solo se admiten archivos PDF", { status: 415 });
    }
    if (!Number.isInteger(input.size) || Number(input.size) < 1 || Number(input.size) > MAX_FILE_SIZE) {
      throw new HTTPError("El tamaño de uno de los PDF no es válido", { status: 400 });
    }
    if (!OCR_IMPORT_FILE_TYPES.includes(input.type as OcrImportFileType)) {
      throw new HTTPError("La clasificación de un archivo no es válida", { status: 400 });
    }

    const lastModified = Number.isFinite(Number(input.lastModified)) ? Number(input.lastModified) : 0;
    const fingerprint = `${input.originalName.toLowerCase()}|${input.size}|${lastModified}`;
    if (fingerprints.has(fingerprint)) {
      throw new HTTPError("El mismo archivo no puede añadirse dos veces", { status: 409 });
    }
    fingerprints.add(fingerprint);

    const id = randomUUID();
    return {
      id,
      originalName: input.originalName,
      size: Number(input.size),
      mimeType: "application/pdf" as const,
      type: input.type as OcrImportFileType,
      order,
      pathname: `${importPrefix(ownerId, importId)}/files/${String(order + 1).padStart(2, "0")}-${id}.pdf`,
    };
  });

  return { files, clientIds: [...clientIds] };
}

export function toImportView(manifest: OcrImportManifest): OcrImportView {
  return {
    id: manifest.id,
    metadata: manifest.metadata,
    files: manifest.files.map(({ id, originalName, size, type, order }) => ({
      id,
      originalName,
      size,
      type,
      order,
    })),
    state: manifest.state,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    error: manifest.error,
  };
}

export async function readImport(ownerId: string, importId: string): Promise<OcrImportManifest | null> {
  const manifest = await readJson<OcrImportManifest>(manifestPath(ownerId, importId));
  return manifest?.ownerId === ownerId && manifest.id === importId ? manifest : null;
}

export async function readCurrentImport(ownerId: string): Promise<OcrImportManifest | null> {
  const pointer = await readJson<CurrentPointer>(currentPath(ownerId));
  if (!pointer?.importId) return null;
  return readImport(ownerId, pointer.importId);
}

export async function listOwnerImports(ownerId: string): Promise<OcrImportManifest[]> {
  ensureBlobConfigured();
  const prefix = `${ownerPrefix(ownerId)}/`;
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor, limit: 1_000 });
    for (const blob of page.blobs) {
      const relative = blob.pathname.slice(prefix.length);
      const match = /^([0-9a-f-]{36})\/manifest\.json$/i.exec(relative);
      if (match) ids.push(match[1]!);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  const manifests = await Promise.all(ids.map((id) => readImport(ownerId, id)));
  return manifests.filter((manifest): manifest is OcrImportManifest => manifest !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function selectImport(ownerId: string, importId: string): Promise<OcrImportManifest> {
  const manifest = await readImport(ownerId, importId);
  if (!manifest) throw new HTTPError("Importación no encontrada", { status: 404 });
  await writeJson(currentPath(ownerId), { importId } satisfies CurrentPointer);
  return manifest;
}

export async function createImport(ownerId: string, raw: CreateImportInput): Promise<{
  manifest: OcrImportManifest;
  uploads: Array<{ clientId: string; fileId: string; pathname: string }>;
}> {
  ensureBlobConfigured();
  const current = await readCurrentImport(ownerId);
  if (current?.state === "subiendo") {
    throw new HTTPError("Ya hay una subida en curso. Termínala o cancélala antes de crear otra.", { status: 409 });
  }

  const id = randomUUID();
  const metadata = normalizeMetadata(raw.metadata);
  const normalized = normalizeFiles(ownerId, id, raw.files);
  const now = new Date().toISOString();
  const manifest: OcrImportManifest = {
    id,
    ownerId,
    metadata,
    files: normalized.files,
    state: "subiendo",
    createdAt: now,
    updatedAt: now,
    error: null,
  };

  await writeJson(manifestPath(ownerId, id), manifest);
  try {
    await writeJson(currentPath(ownerId), { importId: id } satisfies CurrentPointer);
  } catch (error) {
    await del(manifestPath(ownerId, id)).catch(() => undefined);
    throw error;
  }

  return {
    manifest,
    uploads: manifest.files.map((file, index) => ({
      clientId: normalized.clientIds[index]!,
      fileId: file.id,
      pathname: file.pathname,
    })),
  };
}

async function hasPdfSignature(pathname: string): Promise<boolean> {
  const result = await get(pathname, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200 || !result.stream) return false;
  const reader = result.stream.getReader();
  const bytes: number[] = [];
  try {
    while (bytes.length < PDF_SIGNATURE.length) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes.push(...chunk.value.slice(0, PDF_SIGNATURE.length - bytes.length));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return String.fromCharCode(...bytes) === PDF_SIGNATURE;
}

export async function completeImport(ownerId: string, importId: string): Promise<OcrImportManifest> {
  const manifest = await readImport(ownerId, importId);
  if (!manifest) throw new HTTPError("Importación no encontrada", { status: 404 });
  if (manifest.state === "lista") return manifest;

  try {
    for (const file of manifest.files) {
      const metadata = await head(file.pathname);
      if (
        metadata.pathname !== file.pathname
        || metadata.size !== file.size
        || metadata.contentType?.split(";")[0] !== "application/pdf"
        || !(await hasPdfSignature(file.pathname))
      ) {
        throw new Error("invalid_pdf");
      }
    }
  } catch {
    const safeError = "Uno o más archivos no se pudieron validar como PDF.";
    const failed: OcrImportManifest = {
      ...manifest,
      state: "error",
      updatedAt: new Date().toISOString(),
      error: safeError,
    };
    await writeJson(manifestPath(ownerId, importId), failed);
    throw new HTTPError(safeError, { status: 400 });
  }

  const completed: OcrImportManifest = {
    ...manifest,
    state: "lista",
    updatedAt: new Date().toISOString(),
    error: null,
  };
  await writeJson(manifestPath(ownerId, importId), completed);
  return completed;
}

export async function cancelImport(ownerId: string, importId: string): Promise<void> {
  const manifest = await readImport(ownerId, importId);
  if (!manifest) throw new HTTPError("Importación no encontrada", { status: 404 });
  const pointer = await readJson<CurrentPointer>(currentPath(ownerId));
  const prefix = `${importPrefix(ownerId, importId)}/`;
  const paths: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor, limit: 1_000 });
    paths.push(...page.blobs.map((blob) => blob.pathname));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  if (paths.length > 0) await del(paths);
  if (pointer?.importId === importId) {
    const next = (await listOwnerImports(ownerId))[0];
    if (next) await writeJson(currentPath(ownerId), { importId: next.id } satisfies CurrentPointer);
    else await del(currentPath(ownerId));
  }
}

export async function requireImportFile(
  ownerId: string,
  importId: string,
  fileId: string,
): Promise<{ manifest: OcrImportManifest; file: OcrImportFile }> {
  const manifest = await readImport(ownerId, importId);
  const file = manifest?.files.find((item) => item.id === fileId);
  if (!manifest || !file) throw new HTTPError("Archivo no encontrado", { status: 404 });
  return { manifest, file };
}

export const OCR_IMPORT_MAX_FILE_SIZE = MAX_FILE_SIZE;
