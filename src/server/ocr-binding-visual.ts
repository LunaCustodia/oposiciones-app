import { createHash } from "node:crypto";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import "pdfjs-dist/legacy/build/pdf.worker.mjs";
import type { OcrPageExtraction, OcrLayoutElement } from "../shared/ocr-extraction.js";
import type { OcrAnswerEvidence } from "../shared/ocr-binding.js";
import type { OcrSemanticSection } from "../shared/ocr-interpretation.js";

export interface VisualRow {
  number: string;
  section: OcrSemanticSection;
  y: number;
  columns: Record<string, number>;
  radius: number;
}

export interface VisualSample {
  row: VisualRow;
  scores: Record<string, number>;
  answers: string[];
  weak: boolean;
}

export interface BoldRow {
  number: string;
  section: OcrSemanticSection;
  answer: string;
  duplicate: boolean;
  incompatible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function detectBoldRows(pdfBytes: Uint8Array, pageNumber: number, extraction: OcrPageExtraction): Promise<BoldRow[]> {
  const task = getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: true });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    await page.getOperatorList();
    const items = content.items.flatMap((raw) => {
      if (!("str" in raw) || typeof raw.str !== "string" || !/^\d{1,3}$|^[A-E]$/iu.test(raw.str.trim())) return [];
      const item = raw as { str: string; fontName: string; transform: number[]; width: number; height: number };
      let bold = false;
      try { bold = Boolean((page.commonObjs.get(item.fontName) as { bold?: boolean })?.bold); } catch { return []; }
      return [{ text: item.str.trim().toUpperCase(), x: item.transform[4] ?? 0, y: item.transform[5] ?? 0,
        width: item.width, height: item.height, bold }];
    });
    const lines = extraction.lines.map((line) => ({ text: line.text,
      y: line.boundingBoxes[0]?.coordinateSystem === "pdf_points_bottom_left" ? line.boundingBoxes[0].vertices[0]?.y : null }));
    const output: BoldRow[] = [];
    for (const item of items.filter((candidate) => /^\d{1,3}$/u.test(candidate.text))) {
      const letters = items.filter((candidate) => /^[A-E]$/u.test(candidate.text) && Math.abs(candidate.y - item.y) <= 4 && candidate.x > item.x);
      if (new Set(letters.map((candidate) => candidate.text)).size < 3) continue;
      const marked = letters.filter((candidate) => candidate.bold);
      if (marked.length === 0) continue;
      let section: OcrSemanticSection = "desconocida";
      for (const line of lines.filter((line) => line.y !== null && line.y >= item.y - 4).sort((a, b) => b.y! - a.y!)) {
        if (/\breservas?\b/iu.test(line.text)) section = "reserva";
        else if (/\bordinarias?\b/iu.test(line.text)) section = "ordinaria";
      }
      const answer = marked[0]!;
      output.push({ number: item.text, section, answer: answer.text, duplicate: marked.length > 1,
        incompatible: new Set(marked.map((candidate) => candidate.text)).size > 1,
        x: answer.x, y: answer.y, width: answer.width, height: answer.height });
    }
    return output;
  } finally { await task.destroy(); }
}

export interface TextualMarkScore {
  evidenceId: string;
  marks: string[];
  scores: Record<string, number>;
  y: number;
  coordinates: NonNullable<OcrAnswerEvidence["coordinates"]>;
}

// PDF text operators preserve coincident glyphs that direct text extraction can collapse.
// A score is glyph occurrences plus the rendered dark-pixel fraction at the glyph.
export async function inspectTextualMarks(pdfBytes: Uint8Array, pageNumber: number,
  sources: OcrAnswerEvidence[], visual: { width: number; height: number; scale: number; data: Uint8ClampedArray }): Promise<TextualMarkScore[]> {
  const task = getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: true });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const items = content.items.flatMap((raw, index) => {
      if (!("str" in raw) || typeof raw.str !== "string" || !raw.str.trim()) return [];
      const item = raw as { str: string; transform: number[]; width: number; height: number };
      return [{ index, text: item.str.toUpperCase(), x: item.transform[4] ?? 0, y: item.transform[5] ?? 0,
        width: item.width, height: Math.max(item.height, Math.abs(item.transform[3] ?? 0), 6) }];
    });
    const output: TextualMarkScore[] = [];
    for (const source of sources) {
      const box = source.coordinates;
      const number = source.printedNumber?.replace(/[.º°):\s]+$/u, "");
      if (!box || box.coordinateSystem !== "pdf_points_bottom_left" || !number || !/^\d{1,3}$/u.test(number)) continue;
      const nearby = items.filter((item) => item.y >= box.y - 5 && item.y <= box.y + box.height + 5
        && item.x <= box.x + box.width + 8 && item.x + item.width >= box.x - 8);
      const pairs = nearby.flatMap((item) => [...item.text.matchAll(/\b(\d{1,3})\s*[.):-]?\s*([A-E])\b/gu)]
        .filter((match) => String(Number(match[1])) === String(Number(number)))
        .map((match) => ({ item, letter: match[2]!, x: item.x + item.width * ((match.index! + match[0].lastIndexOf(match[2]!)) / Math.max(item.text.length, 1)) })));
      const numberItems = nearby.filter((item) => item.text.trim() === number);
      const anchor = Math.min(...[...pairs.map((pair) => pair.item.x), ...numberItems.map((item) => item.x)]);
      if (!Number.isFinite(anchor)) continue;
      const pairIndexes = new Set(pairs.map((pair) => pair.item.index));
      const lone = nearby.filter((item) => !pairIndexes.has(item.index) && /^[A-E]$/u.test(item.text.trim())
        && item.x > anchor + 4 && item.x < box.x + box.width + 12)
        .map((item) => ({ item, letter: item.text.trim(), x: item.x }));
      const glyphs = [...pairs, ...lone];
      if (!glyphs.length) continue;
      const scores: Record<string, number> = Object.fromEntries("ABCDE".split("").map((letter) => [letter, 0]));
      const positions = new Map<string, { x: number; y: number; height: number }[]>();
      for (const glyph of glyphs) {
        const regionWidth = Math.max(5, Math.min(13, glyph.item.height * 0.75)) * visual.scale;
        const left = Math.round(glyph.x * visual.scale);
        const top = Math.round(visual.height - (glyph.item.y + glyph.item.height) * visual.scale);
        const regionHeight = Math.max(6, glyph.item.height) * visual.scale;
        let dark = 0; let total = 0;
        for (let py = Math.max(0, top); py < Math.min(visual.height, top + regionHeight); py += 1) {
          for (let px = Math.max(0, left); px < Math.min(visual.width, left + regionWidth); px += 1) {
            const offset = (Math.floor(py) * visual.width + Math.floor(px)) * 4;
            const luminance = visual.data[offset]! * 0.2126 + visual.data[offset + 1]! * 0.7152 + visual.data[offset + 2]! * 0.0722;
            if (luminance < 115) dark += 1;
            total += 1;
          }
        }
        const positionsForLetter = positions.get(glyph.letter) ?? [];
        if (!positionsForLetter.some((position) => Math.abs(position.x - glyph.x) < 1.5 && Math.abs(position.y - glyph.item.y) < 1.5)) {
          scores[glyph.letter] += total ? dark / total : 0;
          positionsForLetter.push({ x: glyph.x, y: glyph.item.y, height: glyph.item.height });
          positions.set(glyph.letter, positionsForLetter);
        }
      }
      for (const letter of "ABCDE") scores[letter] = Math.round((scores[letter] + glyphs.filter((glyph) => glyph.letter === letter).length) * 1000) / 1000;
      const minX = Math.min(...glyphs.map((glyph) => glyph.x));
      const maxX = Math.max(...glyphs.map((glyph) => glyph.x + Math.max(5, glyph.item.height * 0.75)));
      const minY = Math.min(...glyphs.map((glyph) => glyph.item.y));
      const maxY = Math.max(...glyphs.map((glyph) => glyph.item.y + glyph.item.height));
      output.push({ evidenceId: source.id, marks: glyphs.map((glyph) => glyph.letter), scores,
        y: visual.height - ((minY + maxY) / 2) * visual.scale,
        coordinates: { coordinateSystem: "pdf_points_bottom_left", x: minX, y: minY, width: maxX - minX, height: maxY - minY } });
    }
    return output;
  } finally { await task.destroy(); }
}

function center(element: OcrLayoutElement, width: number, height: number, scale: number): { x: number; y: number } | null {
  const box = element.boundingBoxes[0];
  if (!box?.vertices.length) return null;
  const x = box.vertices.reduce((sum, point) => sum + point.x, 0) / box.vertices.length;
  const y = box.vertices.reduce((sum, point) => sum + point.y, 0) / box.vertices.length;
  if (box.coordinateSystem === "pdf_points_bottom_left") return { x: x * scale, y: height - y * scale };
  if (box.coordinateSystem === "normalized_top_left") return { x: x * width, y: y * height };
  return { x: x * scale, y: y * scale };
}

export function inferVisualRows(page: OcrPageExtraction, width: number, height: number, scale: number): VisualRow[] {
  const tokens = page.tokens.map((token) => ({ text: token.text.trim().toUpperCase(), point: center(token, width, height, scale) }))
    .filter((item): item is { text: string; point: { x: number; y: number } } => Boolean(item.point));
  const labels = tokens.filter((item) => /^[A-E]$/u.test(item.text));
  const numbers = tokens.filter((item) => /^\d{1,3}[.)]?$/u.test(item.text));
  const candidateGroups = labels.map((seed) => labels.filter((item) => Math.abs(item.point.y - seed.point.y) < 10)
    .sort((a, b) => a.point.x - b.point.x));
  const headers: Array<{ y: number; minX: number; maxX: number; columns: Record<string, number>; radius: number }> = [];
  for (const group of candidateGroups) {
    const clusters: typeof group[] = [];
    for (const item of group) {
      const cluster = clusters.at(-1);
      const gap = cluster ? item.point.x - cluster.at(-1)!.point.x : 0;
      const priorGap = cluster && cluster.length > 1 ? cluster.at(-1)!.point.x - cluster.at(-2)!.point.x : 0;
      if (cluster && !cluster.some((entry) => entry.text === item.text)
        && gap < Math.min(180, width * 0.18) && (!priorGap || gap < priorGap * 2.2)) cluster.push(item);
      else clusters.push([item]);
    }
    for (const cluster of clusters) {
      if (new Set(cluster.map((item) => item.text)).size < 3) continue;
      const y = cluster.reduce((sum, item) => sum + item.point.y, 0) / cluster.length;
      const minX = cluster[0]!.point.x; const maxX = cluster.at(-1)!.point.x;
      if (numbers.some((item) => Math.abs(item.point.y - y) < 8 && item.point.x < minX)) continue;
      if (headers.some((header) => Math.abs(header.y - y) < 8 && Math.abs(header.minX - minX) < 8)) continue;
      const columns: Record<string, number> = {};
      for (const item of cluster) if (columns[item.text] === undefined) columns[item.text] = item.point.x;
      const sortedX = Object.values(columns).sort((a, b) => a - b);
      const gap = Math.min(...sortedX.slice(1).map((x, index) => x - sortedX[index]!));
      if (gap < 8 || gap > width / 3) continue;
      headers.push({ y, minX, maxX, columns, radius: Math.min(9, Math.max(4, gap * 0.27)) });
    }
  }
  if (!headers.length) return [];
  const rowNumbers = numbers.sort((a, b) => a.point.y - b.point.y);
  const output: VisualRow[] = [];
  const textLines = page.lines.map((line) => ({ text: line.text, point: center(line, width, height, scale) }));
  for (const item of rowNumbers) {
    const header = headers.filter((candidate) => candidate.y + 8 < item.point.y
      && item.point.x < candidate.minX && candidate.minX - item.point.x < Math.max(80, candidate.maxX - candidate.minX))
      .sort((a, b) => b.y - a.y)[0];
    if (!header) continue;
    let section: OcrSemanticSection = "desconocida";
    for (const line of textLines.filter((line) => line.point && line.point.y <= item.point.y + 5
      && Math.abs(line.point.x - header.minX) <= Math.max(140, header.maxX - header.minX + 25)).sort((a, b) => a.point!.y - b.point!.y)) {
      if (/\breservas?\b/iu.test(line.text)) section = "reserva";
      else if (/\bordinarias?\b/iu.test(line.text)) section = "ordinaria";
    }
    const number = item.text.replace(/[.)]$/u, "");
    if (output.some((row) => row.number === number && Math.abs(row.y - item.point.y) < 8 && row.section === section)) continue;
    output.push({ number, section, y: item.point.y, columns: header.columns, radius: header.radius });
  }
  return output;
}

export function sampleVisualRow(data: Uint8ClampedArray, width: number, height: number, row: VisualRow): VisualSample {
  const scores: Record<string, number> = {};
  for (const [letter, x] of Object.entries(row.columns)) {
    let dark = 0; let total = 0;
    const radius = row.radius;
    for (let dy = -radius * 0.65; dy <= radius * 0.65; dy += 1) {
      for (let dx = -radius * 0.65; dx <= radius * 0.65; dx += 1) {
        if (dx * dx + dy * dy > (radius * 0.65) ** 2) continue;
        const px = Math.round(x + dx); const py = Math.round(row.y + dy);
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        const offset = (py * width + px) * 4;
        const luminance = (data[offset]! * 0.2126) + (data[offset + 1]! * 0.7152) + (data[offset + 2]! * 0.0722);
        if (luminance < 115) dark += 1;
        total += 1;
      }
    }
    scores[letter] = total ? dark / total : 0;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const baseline = ranked.length > 2 ? ranked.slice(2).reduce((sum, item) => sum + item[1], 0) / (ranked.length - 2) : 0;
  const answers = ranked.filter(([, score]) => score >= 0.32 && score - baseline >= 0.18).map(([letter]) => letter);
  const weak = answers.length === 0 && ranked[0]![1] >= 0.13 || answers.length === 1 && ranked[0]![1] - (ranked[1]?.[1] ?? 0) < 0.13;
  return { row, scores, answers, weak };
}

export async function renderVisualPage(pdfBytes: Uint8Array, pageNumber: number): Promise<{
  width: number; height: number; scale: number; data: Uint8ClampedArray;
  crop: (y: number, radius: number) => Buffer;
  cropRegion: (box: { x: number; y: number; width: number; height: number }) => Buffer;
}> {
  const task = getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: true });
  const pdf = await task.promise;
  try {
    const page = await pdf.getPage(pageNumber);
    const scale = 2.5;
    const viewport = page.getViewport({ scale });
    const width = Math.ceil(viewport.width); const height = Math.ceil(viewport.height);
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.fillStyle = "white"; context.fillRect(0, 0, width, height);
    await page.render({ canvasContext: context as never, viewport, canvas: canvas as never }).promise;
    const data = context.getImageData(0, 0, width, height).data;
    return { width, height, scale, data, crop: (y, radius) => {
      const top = Math.max(0, Math.floor(y - Math.max(18, radius * 2)));
      const bottom = Math.min(height, Math.ceil(y + Math.max(18, radius * 2)));
      const cropCanvas = createCanvas(width, bottom - top);
      cropCanvas.getContext("2d").drawImage(canvas, 0, -top);
      return cropCanvas.toBuffer("image/png");
    }, cropRegion: (box) => {
      const left = Math.max(0, Math.floor((box.x - 18) * scale));
      const top = Math.max(0, Math.floor(height - (box.y + box.height + 9) * scale));
      const right = Math.min(width, Math.ceil((box.x + box.width + 18) * scale));
      const bottom = Math.min(height, Math.ceil(height - (box.y - 9) * scale));
      const cropCanvas = createCanvas(Math.max(1, right - left), Math.max(1, bottom - top));
      cropCanvas.getContext("2d").drawImage(canvas, -left, -top);
      return cropCanvas.toBuffer("image/png");
    } };
  } finally { await task.destroy(); }
}

export function visualEvidence(page: OcrPageExtraction, sample: VisualSample, imageId: string): OcrAnswerEvidence {
  const { row, scores, answers, weak } = sample;
  const double = answers.length > 1;
  const topScore = Math.max(...Object.values(scores));
  const method = /\bomr\b/iu.test(page.text) ? "omr" : /\bcasillas?\b/iu.test(page.text) ? "casilla"
    : /\bsombread[oa]s?\b/iu.test(page.text) ? "sombreado" : "circulo";
  const id = createHash("sha256").update(`${page.fileId}:${page.pageNumber}:${row.section}:${row.number}:${row.y}`).digest("hex").slice(0, 24);
  return { id, printedNumber: row.number, section: row.section, answer: answers.length === 1 ? answers[0]! : null,
    annulled: false, ambiguous: weak || answers.length === 0, method, fileId: page.fileId,
    originalName: page.originalName, page: page.pageNumber,
    coordinates: { coordinateSystem: "pixels_top_left", x: Math.min(...Object.values(row.columns)) - row.radius, y: row.y - row.radius,
      width: Math.max(...Object.values(row.columns)) - Math.min(...Object.values(row.columns)) + row.radius * 2, height: row.radius * 2 },
    imageId, confidence: double ? 1 : Math.min(0.98, Math.max(0.35, topScore)), markScores: scores,
    issues: double ? ["opciones_distintas"] : weak ? ["marca_debil"] : answers.length ? [] : ["sin_marca"],
  };
}
