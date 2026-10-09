import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { OcrPageExtraction, OcrLayoutElement } from "../src/shared/ocr-extraction.js";
import type { OcrAnswerEvidence } from "../src/shared/ocr-binding.js";
import type { OcrQuestionCandidate } from "../src/shared/ocr-interpretation.js";
import { linkAnswers } from "../src/server/ocr-binding-link.js";
import { pageLooksLikeTemplate, parseTextualAnswers } from "../src/server/ocr-binding-text.js";
import { detectBoldRows, inferVisualRows, renderVisualPage, sampleVisualRow } from "../src/server/ocr-binding-visual.js";

function page(text: string, fileId = "template", pageNumber = 1, tokens: OcrLayoutElement[] = [], lines: OcrLayoutElement[] = []): OcrPageExtraction {
  return { importId: "import", fileId, originalName: `${fileId}.pdf`, fileOrder: 1, pageNumber, method: "direct", text,
    blocks: [], paragraphs: [], lines, tokens, readingOrder: { blocks: [], paragraphs: [], lines: [], tokens: [] },
    quality: { valid: true, score: 1, visibleCharacters: text.length, wordCount: text.split(/\s+/).length,
      illegalCharacterRatio: 0, singleCharacterTokenRatio: 0, sourceOrderDiscontinuityRatio: 0 },
    documentAiReason: null, issues: [], sourceSha256: "sha", extractedAt: "2026-10-09T00:00:00Z" };
}
function question(id: string, number: string, section: OcrQuestionCandidate["section"]): OcrQuestionCandidate {
  return { id, printedNumber: number, section, statement: id, subparts: [], options: [], tables: [],
    fileId: "questions", originalName: "questions.pdf", pages: [1], confidence: 1, issues: [] };
}
function evidence(id: string, number: string, section: OcrAnswerEvidence["section"], answer: string | null,
  extra: Partial<OcrAnswerEvidence> = {}): OcrAnswerEvidence {
  return { id, printedNumber: number, section, answer, annulled: false, ambiguous: false, method: "tabla",
    fileId: id, originalName: `${id}.pdf`, page: 1, coordinates: null, imageId: null,
    confidence: 0.95, markScores: null, issues: [], ...extra };
}
function token(text: string, x: number, y: number): OcrLayoutElement {
  return { id: `${text}-${x}-${y}`, text, order: 0, confidence: 1,
    boundingBoxes: [{ coordinateSystem: "pdf_points_bottom_left", vertices: [
      { x, y }, { x: x + 8, y }, { x: x + 8, y: y + 10 }, { x, y: y + 10 },
    ] }] };
}

describe("OCR-05 textual templates and linking", () => {
  it("reads tables and separate PDF, preserving two agreeing sources", () => {
    const first = parseTextualAnswers(page("PLANTILLA ORDINARIAS\n1 C 2 B 3 A", "template-a"), "desconocida");
    const second = parseTextualAnswers(page("RESPUESTAS ORDINARIAS\n1 C", "template-b"), "desconocida");
    const linked = linkAnswers([question("q1", "1", "ordinaria"), question("q2", "2", "ordinaria"), question("q3", "3", "ordinaria")], [...first, ...second]);
    expect(first.map((item) => item.answer)).toEqual(["C", "B", "A"]);
    expect(linked.counts.linked).toBe(3);
    expect(linked.bindings[0]?.sources).toHaveLength(2);
  });
  it("separates ordinary and reserve numbers, annuls, and leaves missing/orphan rows", () => {
    const answers = parseTextualAnswers(page("ORDINARIAS\n1 C\nRESERVAS\n1 B\n2 ANULAR\n9 A"), "desconocida");
    const result = linkAnswers([question("ordinary", "1", "ordinaria"), question("reserve", "1", "reserva"),
      question("annul", "2", "reserva"), question("missing", "3", "ordinaria")], answers);
    expect(result.bindings.map((item) => item.state)).toEqual(["vinculada", "vinculada", "anulada", "sin_respuesta"]);
    expect(result.bindings[0]?.answer).toBe("C");
    expect(result.bindings[1]?.answer).toBe("B");
    expect(result.counts.orphans).toBe(1);
  });
  it("does not link unknown section when two questions have the same number", () => {
    const result = linkAnswers([question("ordinary", "1", "ordinaria"), question("reserve", "1", "reserva")], [evidence("e", "1", "desconocida", "A")]);
    expect(result.counts.orphans).toBe(1);
    expect(result.counts.unanswered).toBe(2);
  });
  it("infers an unlabeled row from unequivocal rows on the same template page", () => {
    const sources = [evidence("a", "1", "desconocida", "B", { fileId: "template", page: 16 }),
      evidence("b", "6", "desconocida", "C", { fileId: "template", page: 16 }),
      evidence("c", "7", "desconocida", "D", { fileId: "template", page: 16 })];
    const result = linkAnswers([question("ordinary-1", "1", "ordinaria"), question("reserve-1", "1", "reserva"),
      question("ordinary-6", "6", "ordinaria"), question("ordinary-7", "7", "ordinaria")], sources);
    expect(result.counts.linked).toBe(3);
    expect(result.bindings[0]?.answer).toBe("B");
    expect(result.bindings[1]?.state).toBe("sin_respuesta");
    expect(result.counts.orphans).toBe(0);
  });
  it("flags two visible answer letters in one row instead of choosing one", () => {
    const rows = parseTextualAnswers(page("PLANTILLA ORDINARIAS\n32 B B\n33 C"), "desconocida");
    expect(rows[0]?.issues).toContain("doble_marca");
    expect(rows[0]?.answer).toBeNull();
    expect(rows[1]?.answer).toBe("C");
  });
  it("reports double marks, incompatible templates and weak marks as conflicts or ambiguity", () => {
    const result = linkAnswers([question("q1", "1", "ordinaria"), question("q2", "2", "ordinaria"), question("q3", "3", "ordinaria")], [
      evidence("a", "1", "ordinaria", "A"), evidence("b", "1", "ordinaria", "B"),
      evidence("c", "2", "ordinaria", null, { issues: ["doble_marca"] }),
      evidence("d", "3", "ordinaria", "C", { ambiguous: true, confidence: 0.45 }),
    ]);
    expect(result.counts.conflicts).toBe(2);
    expect(result.counts.ambiguous).toBe(1);
    expect(result.bindings[0]?.sources).toHaveLength(2);
  });
  it("requires explicit template evidence before parsing", () => {
    expect(pageLooksLikeTemplate(page("Una pregunta con cuatro opciones A B C D"), false, false)).toBe(false);
    expect(pageLooksLikeTemplate(page("PLANTILLA\n1 C"), false, false)).toBe(true);
    expect(parseTextualAnswers(page("PLANTILLA\n1 A B C D"), "ordinaria")).toHaveLength(0);
  });
});

describe("OCR-05 geometric marks", () => {
  it("reads an unequivocally bold option without treating every option label as a textual answer", async () => {
    const document = await PDFDocument.create();
    const sheet = document.addPage([400, 400]);
    const regular = await document.embedFont(StandardFonts.Helvetica);
    const bold = await document.embedFont(StandardFonts.HelveticaBold);
    sheet.drawText("1", { x: 50, y: 300, font: regular, size: 12 });
    for (const [letter, x] of [["A", 90], ["B", 130], ["C", 170], ["D", 210]] as const) {
      sheet.drawText(letter, { x, y: 300, font: letter === "C" ? bold : regular, size: 12 });
    }
    const found = await detectBoldRows(await document.save(), 1, page("PLANTILLA\n1 A B C D"));
    expect(found.map((item) => item.answer)).toEqual(["C"]);
  });
  it("preserves two bold marks on the same row as a conflict", async () => {
    const document = await PDFDocument.create();
    const sheet = document.addPage([400, 400]);
    const regular = await document.embedFont(StandardFonts.Helvetica);
    const bold = await document.embedFont(StandardFonts.HelveticaBold);
    sheet.drawText("32", { x: 50, y: 300, font: regular, size: 12 });
    for (const [letter, x] of [["A", 90], ["B", 130], ["B", 165], ["C", 205], ["D", 245]] as const) {
      sheet.drawText(letter, { x, y: 300, font: letter === "B" ? bold : regular, size: 12 });
    }
    const found = await detectBoldRows(await document.save(), 1, page("PLANTILLA\n32 A B B C D"));
    expect(found).toMatchObject([{ number: "32", answer: "B", duplicate: true }]);
  });
  it("ignores empty borders and flags a weak or shaded mark for review", () => {
    const width = 100; const height = 60;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    const row = { number: "1", section: "ordinaria" as const, y: 30, columns: { A: 25, B: 65 }, radius: 8 };
    for (let x = 22; x <= 27; x += 1) for (let y = 28; y <= 33; y += 1) {
      if ((x + y) % 3 !== 0) continue;
      const at = (y * width + x) * 4; data[at] = 80; data[at + 1] = 80; data[at + 2] = 80;
    }
    const sampled = sampleVisualRow(data, width, height, row);
    expect(sampled.answers).toEqual([]);
    expect(sampled.weak).toBe(true);
    const empty = sampleVisualRow(new Uint8ClampedArray(width * height * 4).fill(255), width, height, row);
    expect(empty.answers).toEqual([]);
    expect(empty.weak).toBe(false);
  });
  it("keeps OMR ordinary and reserve blocks with the same printed number separate", () => {
    const tokens = [token("A", 130, 320), token("B", 170, 320), token("C", 210, 320),
      token("1", 70, 280), token("A", 130, 190), token("B", 170, 190), token("C", 210, 190), token("1", 70, 150)];
    const lines = [token("ORDINARIAS", 50, 350), token("RESERVAS", 50, 220)];
    const inferred = inferVisualRows(page("ORDINARIAS\nA B C\n1\nRESERVAS\nA B C\n1", "omr", 1, tokens, lines), 1000, 1000, 2.5);
    expect(inferred.map((row) => [row.number, row.section])).toEqual([["1", "ordinaria"], ["1", "reserva"]]);
  });
  it("renders an OMR-style technical PDF and detects a filled circle and a double mark", async () => {
    const document = await PDFDocument.create();
    const sheet = document.addPage([400, 400]);
    const font = await document.embedFont(StandardFonts.Helvetica);
    const columns = [130, 170, 210, 250];
    const rows = [270, 230];
    sheet.drawText("PLANTILLA OMR ORDINARIAS", { x: 50, y: 350, font, size: 12 });
    columns.forEach((x, index) => sheet.drawText("ABCD"[index]!, { x, y: 310, font, size: 11 }));
    rows.forEach((y, row) => {
      sheet.drawText(String(row + 1), { x: 70, y, font, size: 11 });
      columns.forEach((x, col) => sheet.drawCircle({ x: x + 4, y: y + 5, size: 7,
        borderColor: rgb(0, 0, 0), borderWidth: 1,
        color: row === 0 && col === 2 || row === 1 && (col === 0 || col === 1) ? rgb(0, 0, 0) : rgb(1, 1, 1) }));
    });
    const bytes = await document.save();
    const tokens = [token("A", 130, 310), token("B", 170, 310), token("C", 210, 310), token("D", 250, 310),
      token("1", 70, 270), token("2", 70, 230)];
    const visual = await renderVisualPage(bytes, 1);
    const inferred = inferVisualRows(page("PLANTILLA OMR ORDINARIAS\nA B C D\n1\n2", "omr", 1, tokens), visual.width, visual.height, visual.scale);
    expect(inferred).toHaveLength(2);
    expect(sampleVisualRow(visual.data, visual.width, visual.height, inferred[0]!).answers).toEqual(["C"]);
    expect(sampleVisualRow(visual.data, visual.width, visual.height, inferred[1]!).answers.sort()).toEqual(["A", "B"]);
    expect(visual.crop(inferred[0]!.y, inferred[0]!.radius).subarray(0, 8).toString()).toContain("PNG");
  });
  it("distinguishes a filled checkbox from an empty square border", async () => {
    const document = await PDFDocument.create();
    const sheet = document.addPage([300, 300]);
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (const [letter, x] of [["A", 100], ["B", 140], ["C", 180]] as const) {
      sheet.drawText(letter, { x, y: 240, font, size: 11 });
      sheet.drawRectangle({ x: x - 1, y: 196, width: 11, height: 11, borderColor: rgb(0, 0, 0), borderWidth: 1,
        color: letter === "B" ? rgb(0, 0, 0) : rgb(1, 1, 1) });
    }
    sheet.drawText("1", { x: 50, y: 195, font, size: 11 });
    const visual = await renderVisualPage(await document.save(), 1);
    const inferred = inferVisualRows(page("PLANTILLA CASILLAS\nA B C\n1", "boxes", 1,
      [token("A", 100, 240), token("B", 140, 240), token("C", 180, 240), token("1", 50, 195)]), visual.width, visual.height, visual.scale);
    expect(inferred).toHaveLength(1);
    expect(sampleVisualRow(visual.data, visual.width, visual.height, inferred[0]!).answers).toEqual(["B"]);
  });
});
