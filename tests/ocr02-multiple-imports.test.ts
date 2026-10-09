import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const blobs = vi.hoisted(() => new Map<string, string>());

vi.mock("@vercel/blob", () => ({
  get: vi.fn(async (pathname: string) => {
    const value = blobs.get(pathname);
    return value === undefined ? null : { statusCode: 200, stream: new Response(value).body };
  }),
  put: vi.fn(async (pathname: string, value: string) => { blobs.set(pathname, value); }),
  del: vi.fn(async (paths: string | string[]) => {
    for (const pathname of Array.isArray(paths) ? paths : [paths]) blobs.delete(pathname);
  }),
  list: vi.fn(async ({ prefix }: { prefix: string }) => ({
    blobs: [...blobs.keys()].filter((pathname) => pathname.startsWith(prefix)).map((pathname) => ({ pathname })),
    hasMore: false,
  })),
  head: vi.fn(),
}));

import { cancelImport, createImport, listOwnerImports, readCurrentImport, readImport, selectImport } from "../src/server/ocr-imports.js";

const file = (name: string) => ({
  clientId: name, originalName: name, size: 100, mimeType: "application/pdf", type: "auto", lastModified: 1,
});
const previousBlobStoreId = process.env.BLOB_STORE_ID;

describe("OCR-02: varios exámenes privados del mismo propietario", () => {
  beforeEach(() => {
    blobs.clear();
    process.env.BLOB_STORE_ID = "test-private-store";
  });
  afterEach(() => {
    if (previousBlobStoreId === undefined) delete process.env.BLOB_STORE_ID;
    else process.env.BLOB_STORE_ID = previousBlobStoreId;
  });

  it("permite crear otro examen, volver al anterior y conservar sus archivos y revisión", async () => {
    const first = (await createImport("owner-a", { files: [file("Carmona.pdf")] })).manifest;
    const firstPath = `ocr02/imports/owner-a/${first.id}/manifest.json`;
    blobs.set(firstPath, JSON.stringify({ ...first, state: "lista" }));
    blobs.set(`ocr02/imports/owner-a/${first.id}/files/01-technical.pdf`, "private-pdf");
    blobs.set(`ocr02/imports/owner-a/${first.id}/review/draft.json`, "private-review");

    const second = (await createImport("owner-a", { files: [file("Otro.pdf")] })).manifest;
    expect((await readCurrentImport("owner-a"))?.id).toBe(second.id);
    expect((await listOwnerImports("owner-a")).map((item) => item.id)).toContain(first.id);
    expect(blobs.has(firstPath)).toBe(true);

    await selectImport("owner-a", first.id);
    expect((await readCurrentImport("owner-a"))?.id).toBe(first.id);
    expect(blobs.has(`ocr02/imports/owner-a/${first.id}/files/01-technical.pdf`)).toBe(true);
    expect(blobs.has(`ocr02/imports/owner-a/${first.id}/review/draft.json`)).toBe(true);
  });

  it("no muestra ni permite seleccionar las importaciones de otro propietario", async () => {
    const first = (await createImport("owner-a", { files: [file("Carmona.pdf")] })).manifest;
    expect(await listOwnerImports("owner-b")).toEqual([]);
    expect(await readImport("owner-b", first.id)).toBeNull();
    await expect(selectImport("owner-b", first.id)).rejects.toThrow("Importación no encontrada");
  });

  it("al cancelar solo el examen actual recupera el anterior sin borrarlo", async () => {
    const first = (await createImport("owner-a", { files: [file("Carmona.pdf")] })).manifest;
    blobs.set(`ocr02/imports/owner-a/${first.id}/manifest.json`, JSON.stringify({ ...first, state: "lista" }));
    const second = (await createImport("owner-a", { files: [file("Otro.pdf")] })).manifest;
    await cancelImport("owner-a", second.id);
    expect((await readCurrentImport("owner-a"))?.id).toBe(first.id);
    expect(await readImport("owner-a", second.id)).toBeNull();
    expect(await readImport("owner-a", first.id)).not.toBeNull();
  });
});
