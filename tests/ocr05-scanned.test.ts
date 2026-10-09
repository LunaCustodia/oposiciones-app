import { readFile } from "node:fs/promises";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { get } from "@vercel/blob";
import { analyzeScannedOmr, probeScannedOmrPages, scannedOmrCrop, scannedOmrEvidence } from "../src/server/ocr-binding-scanned.js";
import { renderVisualPage } from "../src/server/ocr-binding-visual.js";
import { buildBindingPlan, readBindingStatus } from "../src/server/ocr-binding.js";
import { linkAnswers } from "../src/server/ocr-binding-link.js";
import { readPageExtraction } from "../src/server/ocr-extractions.js";
import { readInterpretationResult } from "../src/server/ocr-interpretation.js";
import { parseTextualAnswers } from "../src/server/ocr-binding-text.js";
import type { OcrImportManifest } from "../src/shared/ocr-import.js";

describe("OCR-05: enrutamiento y lectura de plantilla fotocopiada", () => {
  it.skipIf(!process.env.OCR_REAL_PDF_PATH)("detecta únicamente la página 2 y sus 75+10 marcas reales", async () => {
    const pdf = await readFile(process.env.OCR_REAL_PDF_PATH!);
    const texts = new Map([[2, "PREGUNTAS RESERVA"]]);
    const pages = await probeScannedOmrPages(pdf, Array.from({ length: 18 }, (_, index) => index + 1), texts);
    expect([...pages]).toEqual([2]);
    const visual = await renderVisualPage(pdf, 2, 350 / 72);
    const analyzed = analyzeScannedOmr(visual.data, visual.width, visual.height, visual.scale, texts.get(2)!);
    expect(analyzed.structural).toBe(true);
    expect(analyzed.rows.filter((row) => row.section === "ordinaria").map((row) => Number(row.number)).sort((a, b) => a - b))
      .toEqual(Array.from({ length: 75 }, (_, index) => index + 1));
    expect(analyzed.rows.filter((row) => row.section === "reserva")).toHaveLength(10);
    expect(analyzed.rows.every((row) => row.answers.length === 1 && !row.weak)).toBe(true);
    for (const [section, number, answer] of [
      ["ordinaria", "1", "D"], ["ordinaria", "30", "A"], ["ordinaria", "31", "D"],
      ["ordinaria", "44", "A"], ["ordinaria", "60", "B"], ["ordinaria", "61", "D"],
      ["ordinaria", "75", "B"], ["reserva", "1", "B"], ["reserva", "5", "B"],
      ["reserva", "10", "A"],
    ]) {
      expect(analyzed.rows.find((row) => row.section === section && row.number === number)?.answers).toEqual([answer]);
    }
    for (const rasterPath of (process.env.OCR_REAL_RASTER_PATHS ?? "").split(";").filter(Boolean)) {
      const image = await loadImage(await readFile(rasterPath));
      const canvas = createCanvas(image.width, image.height);
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const fromIndependentRaster = analyzeScannedOmr(context.getImageData(0, 0, image.width, image.height).data,
        image.width, image.height, 350 / 72, texts.get(2)!);
      const key = (rows: typeof analyzed.rows) => Object.fromEntries(rows.map((row) =>
        [`${row.section}:${row.number}`, row.answers.join("+")]));
      expect(key(analyzed.rows)).toEqual(key(fromIndependentRaster.rows));
      if (fromIndependentRaster.correction) {
        expect(scannedOmrCrop(fromIndependentRaster, fromIndependentRaster.rows[0]!)).toBeTruthy();
      }
    }
  });

  it.skipIf(!process.env.OCR_REAL_OWNER_ID || !process.env.OCR_REAL_IMPORT_ID)("enruta la importación existente a una sola página", async () => {
    const ownerId = process.env.OCR_REAL_OWNER_ID!;
    const importId = process.env.OCR_REAL_IMPORT_ID!;
    const blob = await get(`ocr02/imports/${ownerId}/${importId}/manifest.json`, { access: "private", useCache: false });
    expect(blob?.stream).toBeTruthy();
    const manifest = JSON.parse(await new Response(blob!.stream).text()) as OcrImportManifest;
    const plan = await buildBindingPlan(ownerId, manifest);
    expect(plan.refs).toEqual([{ fileId: manifest.files[0]!.id, pageNumber: 2, visualOmr: true }]);
    const previous = await readBindingStatus(ownerId, importId);
    expect(previous).toBeTruthy();
    expect(plan.fingerprint).not.toBe(previous!.fingerprint);
    const page = await readPageExtraction(ownerId, importId, manifest.files[0]!.id, 2);
    const interpretation = await readInterpretationResult(ownerId, importId);
    expect(page).toBeTruthy(); expect(interpretation).toBeTruthy();
    expect(parseTextualAnswers(page!, "desconocida")).toHaveLength(0);
    expect(interpretation!.answers.filter((answer) => answer.page === 2)).toHaveLength(0);
    const pdf = await readFile(process.env.OCR_REAL_PDF_PATH!);
    const visual = await renderVisualPage(pdf, 2, 350 / 72);
    const rows = analyzeScannedOmr(visual.data, visual.width, visual.height, visual.scale, page!.text).rows;
    const evidence = rows.map((row, index) => scannedOmrEvidence(page!, row, String(index).padStart(24, "0")));
    const linked = linkAnswers(interpretation!.questions, evidence);
    expect(linked.counts).toMatchObject({ questions: 85, answerRows: 85, associated: 85,
      linked: 85, unanswered: 0, ambiguous: 0, conflicts: 0, orphans: 0 });
  });

  it.skipIf(!process.env.OCR_REAL_OWNER_ID || !process.env.OCR_CARMONA_IMPORT_ID)("conserva la selección de plantillas de Carmona", async () => {
    const ownerId = process.env.OCR_REAL_OWNER_ID!;
    const importId = process.env.OCR_CARMONA_IMPORT_ID!;
    const blob = await get(`ocr02/imports/${ownerId}/${importId}/manifest.json`, { access: "private", useCache: false });
    const manifest = JSON.parse(await new Response(blob!.stream).text()) as OcrImportManifest;
    const plan = await buildBindingPlan(ownerId, manifest);
    expect(plan.refs.map((ref) => ref.pageNumber)).toEqual([16, 17, 18]);
    const previous = await readBindingStatus(ownerId, importId);
    expect(previous).toBeTruthy();
    expect(plan.fingerprint).toBe(previous!.fingerprint);
    const evidence = [];
    for (const n of [16, 17, 18]) {
      const page = await readPageExtraction(ownerId, importId, manifest.files[0]!.id, n);
      expect(page).toBeTruthy();
      evidence.push(...parseTextualAnswers(page!, "desconocida"));
    }
    const interpretation = await readInterpretationResult(ownerId, importId);
    expect(interpretation).toBeTruthy();
    const linked = linkAnswers(interpretation!.questions, evidence);
    expect(linked.counts).toMatchObject({ questions: 85, answerRows: 85, associated: 85, linked: 85, unanswered: 0 });
  });
});
