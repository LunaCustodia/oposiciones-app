import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import type { OcrSemanticSection } from "../shared/ocr-interpretation.js";
import type { OcrPageExtraction } from "../shared/ocr-extraction.js";
import type { OcrAnswerEvidence } from "../shared/ocr-binding.js";
import { pdfJsImageOptions } from "./ocr-pdfjs-assets.js";

interface MarkComponent { x: number; y: number; area: number; }
interface AxisGroup { center: number; marks: MarkComponent[]; }

export interface ScannedOmrRow {
  number: string;
  section: OcrSemanticSection;
  x: number;
  y: number;
  width: number;
  radius: number;
  scores: Record<string, number>;
  answers: string[];
  weak: boolean;
}

export interface ScannedOmrAnalysis {
  rows: ScannedOmrRow[];
  markCount: number;
  structural: boolean;
  correction?: { rotationDegrees: number; canvas: Canvas };
}

export function scannedOmrEvidence(page: OcrPageExtraction, row: ScannedOmrRow, imageId: string): OcrAnswerEvidence {
  const double = row.answers.length > 1;
  const answer = row.answers.length === 1 ? row.answers[0]! : null;
  const issues = double ? ["opciones_distintas"] : row.weak ? ["marca_debil"] : row.answers.length ? [] : ["sin_marca"];
  return { id: imageId, printedNumber: row.number, section: row.section, answer,
    annulled: false, ambiguous: row.weak || row.answers.length === 0, method: "omr",
    fileId: page.fileId, originalName: page.originalName, page: page.pageNumber,
    coordinates: { coordinateSystem: "pixels_top_left", x: row.x, y: row.y - row.radius,
      width: row.width, height: row.radius * 2 }, imageId,
    confidence: row.weak ? 0.55 : 0.96, markScores: row.scores, issues };
}

function blueInk(data: Uint8ClampedArray, offset: number): boolean {
  const red = data[offset]!; const green = data[offset + 1]!; const blue = data[offset + 2]!;
  return blue > 55 && red < 170 && blue > red * 1.16 && blue > green * 1.08;
}

function markedPixel(data: Uint8ClampedArray, offset: number, monochrome: boolean): boolean {
  if (!monochrome) return blueInk(data, offset);
  const red = data[offset]!; const green = data[offset + 1]!; const blue = data[offset + 2]!;
  return red * 0.2126 + green * 0.7152 + blue * 0.0722 < 140;
}

function findInkComponents(data: Uint8ClampedArray, width: number, height: number, scale: number,
  monochrome: boolean): MarkComponent[] {
  const mask = new Uint8Array(width * height);
  let marked = 0;
  const xStart = Math.floor(width * 0.1); const xEnd = Math.ceil(width * 0.88);
  const yStart = Math.floor(height * 0.07); const yEnd = Math.ceil(height * 0.92);
  for (let y = yStart; y < yEnd; y += 1) for (let x = xStart; x < xEnd; x += 1) {
    const index = y * width + x;
    if (markedPixel(data, index * 4, monochrome)) { mask[index] = 1; marked += 1; }
  }
  const queue = new Int32Array(Math.max(1, marked));
  const found: MarkComponent[] = [];
  for (let y = yStart; y < yEnd; y += 1) for (let x = xStart; x < xEnd; x += 1) {
    const start = y * width + x;
    if (mask[start] !== 1) continue;
    let head = 0; let tail = 1; queue[0] = start; mask[start] = 2;
    let sumX = 0; let sumY = 0; let minX = x; let maxX = x; let minY = y; let maxY = y;
    while (head < tail) {
      const at = queue[head++]!; const px = at % width; const py = Math.floor(at / width);
      sumX += px; sumY += py;
      minX = Math.min(minX, px); maxX = Math.max(maxX, px);
      minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        if (!dx && !dy) continue;
        const nx = px + dx; const ny = py + dy;
        if (nx < xStart || nx >= xEnd || ny < yStart || ny >= yEnd) continue;
        const next = ny * width + nx;
        if (mask[next] === 1) { mask[next] = 2; queue[tail++] = next; }
      }
    }
    const boxWidth = maxX - minX + 1; const boxHeight = maxY - minY + 1;
    if (tail >= 10 * scale * scale && tail <= 110 * scale * scale
      && boxWidth >= 4 * scale && boxWidth <= 15 * scale
      && boxHeight >= 3 * scale && boxHeight <= 12 * scale) {
      found.push({ x: sumX / tail, y: sumY / tail, area: tail });
    }
  }
  return found;
}

function groupAxis(marks: MarkComponent[], axis: "x" | "y", tolerance: number): AxisGroup[] {
  const groups: AxisGroup[] = [];
  for (const mark of [...marks].sort((a, b) => a[axis] - b[axis])) {
    const last = groups.at(-1);
    if (last && mark[axis] - last.center <= tolerance) {
      last.marks.push(mark);
      last.center = last.marks.reduce((sum, item) => sum + item[axis], 0) / last.marks.length;
    } else groups.push({ center: mark[axis], marks: [mark] });
  }
  return groups;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
}

function regularSpacing(groups: AxisGroup[], min: number, max: number): number {
  const gaps = groups.slice(1).map((group, index) => group.center - groups[index]!.center)
    .filter((gap) => gap >= min && gap <= max);
  return median(gaps);
}

function rowIndex(y: number, first: number, pitch: number): number {
  return Math.round((y - first) / pitch);
}

function regularLattice(groups: AxisGroup[], pitch: number, tolerance: number): AxisGroup[] {
  let best: AxisGroup[] = [];
  for (const start of groups) {
    const aligned = groups.filter((group) => group.center >= start.center - tolerance
      && Math.abs(group.center - (start.center + rowIndex(group.center, start.center, pitch) * pitch)) <= tolerance);
    if (aligned.length > best.length) best = aligned;
  }
  return best;
}

function sampleInk(data: Uint8ClampedArray, width: number, height: number, x: number, y: number, radius: number,
  monochrome: boolean): number {
  let marked = 0; let total = 0;
  const core = radius * 0.8;
  for (let dy = -Math.ceil(core); dy <= Math.ceil(core); dy += 1) for (let dx = -Math.ceil(core); dx <= Math.ceil(core); dx += 1) {
    if (dx * dx + dy * dy > core * core) continue;
    const px = Math.round(x + dx); const py = Math.round(y + dy);
    if (px < 0 || py < 0 || px >= width || py >= height) continue;
    total += 1;
    if (markedPixel(data, (py * width + px) * 4, monochrome)) marked += 1;
  }
  return total ? marked / total : 0;
}

function analyzeMode(data: Uint8ClampedArray, width: number, height: number, scale: number,
  text: string, monochrome: boolean): ScannedOmrAnalysis {
  const components = findInkComponents(data, width, height, scale, monochrome);
  if (components.length < 8 || components.length > 300) return { rows: [], markCount: components.length, structural: false };
  const xGroups = groupAxis(components, "x", 4 * scale)
    .filter((group) => !monochrome || group.marks.length >= 2);
  const xGaps = xGroups.slice(1).map((group, index) => group.center - xGroups[index]!.center);
  const closeGaps = xGaps.filter((gap) => gap > 4 * scale && gap < 40 * scale);
  const spacing = median(closeGaps.filter((gap) => gap <= median(closeGaps) * 1.25));
  if (!spacing || xGroups.length < 3) return { rows: [], markCount: components.length, structural: false };
  const blocks: AxisGroup[][] = [];
  for (const group of xGroups) {
    const current = blocks.at(-1);
    if (current && group.center - current.at(-1)!.center <= spacing * 1.65) current.push(group);
    else blocks.push([group]);
  }
  const complete = blocks.filter((block) => block.length === 4 && block.reduce((sum, group) => sum + group.marks.length, 0) >= 6);
  if (!complete.length) return { rows: [], markCount: components.length, structural: false };
  const allRows = groupAxis(components, "y", 4 * scale);
  const pitch = regularSpacing(allRows, 8 * scale, 35 * scale);
  if (!pitch || allRows.length < 8) return { rows: [], markCount: components.length, structural: false };

  const regions: AxisGroup[][][] = [];
  for (const block of complete) {
    const previous = regions.at(-1)?.at(-1);
    if (previous && block[0]!.center - previous.at(-1)!.center <= spacing * 4.5) regions.at(-1)!.push(block);
    else regions.push([block]);
  }
  const reserveRegion = regions.length > 1 && /\breservas?\b/iu.test(text)
    ? regions.at(-1) : null;
  const mainBlocks = regions.filter((region) => region !== reserveRegion).flat();
  const mainMarks = mainBlocks.flatMap((block) => block.flatMap((group) => group.marks));
  const allMainY = groupAxis(mainMarks, "y", 4 * scale);
  const mainPitch = regularSpacing(allMainY, 8 * scale, 35 * scale) || pitch;
  const mainY = regularLattice(allMainY, mainPitch, 5 * scale);
  const rowsPerBlock = mainY.length ? Math.max(...mainY.map((group) => rowIndex(group.center, mainY[0]!.center, mainPitch))) + 1 : 0;
  if (!rowsPerBlock || rowsPerBlock > 60) return { rows: [], markCount: components.length, structural: false };
  const rows: ScannedOmrRow[] = [];
  for (const [regionIndex, region] of regions.entries()) {
    const reserve = region === reserveRegion;
    const regionMarks = region.flatMap((block) => block.flatMap((group) => group.marks));
    const allRegionY = groupAxis(regionMarks, "y", 4 * scale);
    const regionPitch = regularSpacing(allRegionY, 8 * scale, 35 * scale) || pitch;
    const yGroups = regularLattice(allRegionY, regionPitch, 5 * scale);
    if (!yGroups.length) continue;
    for (const [blockIndex, block] of region.entries()) {
      const blockMarks = block.flatMap((group) => group.marks);
      const blockRows = groupAxis(blockMarks, "y", 4 * scale);
      for (const group of blockRows) {
        const index = rowIndex(group.center, yGroups[0]!.center, regionPitch);
        if (index < 0 || index > 60 || Math.abs(group.center - (yGroups[0]!.center + index * regionPitch)) > 5 * scale) continue;
        const absoluteBlock = reserve ? blockIndex : mainBlocks.findIndex((item) => item === block);
        const number = reserve ? index + 1 : absoluteBlock * rowsPerBlock + index + 1;
        const radius = spacing * 0.34;
        const scores: Record<string, number> = {};
        for (const [optionIndex, option] of block.entries()) {
          scores["ABCD"[optionIndex]!] = Math.round(sampleInk(data, width, height, option.center, group.center, radius, monochrome) * 1000) / 1000;
        }
        const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
        const answers = ranked.filter(([, score]) => score >= 0.14 && score >= ranked[0]![1] * 0.55).map(([letter]) => letter);
        const weak = answers.length === 0 || (answers.length === 1 && ranked[0]![1] - (ranked[1]?.[1] ?? 0) < 0.12);
        rows.push({ number: String(number), section: reserve ? "reserva" : "ordinaria",
          x: block[0]!.center - radius, y: group.center,
          width: block.at(-1)!.center - block[0]!.center + radius * 2,
          radius, scores, answers, weak });
      }
    }
    if (regionIndex === 0 && mainBlocks.length === 0) break;
  }
  const distinct = new Set(rows.map((row) => `${row.section}:${row.number}`));
  return { rows, markCount: components.length, structural: distinct.size >= 8
    && distinct.size === rows.length && rows.length >= components.length * 0.6 };
}

function analyzeRaw(data: Uint8ClampedArray, width: number, height: number, scale: number,
  text: string): ScannedOmrAnalysis {
  const chromatic = analyzeMode(data, width, height, scale, text, false);
  if (chromatic.structural) return chromatic;
  const monochrome = analyzeMode(data, width, height, scale, text, true);
  return monochrome.structural ? monochrome : chromatic;
}

function rotatePixels(source: Canvas, degrees: number): {
  canvas: Canvas; data: Uint8ClampedArray;
} {
  const rotated = createCanvas(source.width, source.height);
  const context = rotated.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, rotated.width, rotated.height);
  context.translate(rotated.width / 2, rotated.height / 2);
  context.rotate(degrees * Math.PI / 180);
  context.drawImage(source, -source.width / 2, -source.height / 2);
  return { canvas: rotated, data: context.getImageData(0, 0, rotated.width, rotated.height).data };
}

export function analyzeScannedOmr(data: Uint8ClampedArray, width: number, height: number, scale: number,
  text: string): ScannedOmrAnalysis {
  const direct = analyzeRaw(data, width, height, scale, text);
  if (direct.structural || direct.markCount < 8 || direct.markCount > 300) return direct;
  const original = createCanvas(width, height);
  const originalContext = original.getContext("2d");
  const image = originalContext.createImageData(width, height);
  image.data.set(data);
  originalContext.putImageData(image, 0, 0);
  const factor = Math.min(1, 1.5 / scale);
  const sampleWidth = Math.round(width * factor); const sampleHeight = Math.round(height * factor);
  const sample = createCanvas(sampleWidth, sampleHeight);
  sample.getContext("2d").drawImage(original, 0, 0, sampleWidth, sampleHeight);
  let best: { angle: number; count: number } | null = null;
  for (const magnitude of [0.5, 1, 1.5, 2, 2.5, 3]) for (const sign of [-1, 1]) {
    const angle = magnitude * sign;
    const rotated = rotatePixels(sample, angle);
    const analysis = analyzeRaw(rotated.data, sampleWidth, sampleHeight, scale * factor, text);
    if (analysis.structural && (!best || analysis.rows.length > best.count)) best = { angle, count: analysis.rows.length };
  }
  if (!best) return direct;
  const corrected = rotatePixels(original, best.angle);
  const analysis = analyzeRaw(corrected.data, width, height, scale, text);
  return analysis.structural ? { ...analysis, correction: { rotationDegrees: best.angle, canvas: corrected.canvas } } : direct;
}

export function scannedOmrCrop(analysis: ScannedOmrAnalysis, row: ScannedOmrRow): Buffer | null {
  if (!analysis.correction) return null;
  const source = analysis.correction.canvas;
  const { width, height } = source;
  const left = Math.max(0, Math.floor(row.x - row.radius));
  const top = Math.max(0, Math.floor(row.y - row.radius * 1.7));
  const right = Math.min(width, Math.ceil(row.x + row.width + row.radius));
  const bottom = Math.min(height, Math.ceil(row.y + row.radius * 1.7));
  const crop = createCanvas(Math.max(1, right - left), Math.max(1, bottom - top));
  crop.getContext("2d").drawImage(source, -left, -top);
  return crop.toBuffer("image/png");
}

export async function probeScannedOmrPages(pdfBytes: Uint8Array, pageNumbers: number[], texts: Map<number, string>): Promise<Set<number>> {
  const found = new Set<number>();
  const task = getDocument({ data: new Uint8Array(pdfBytes), ...pdfJsImageOptions() });
  try {
    const pdf = await task.promise;
    for (const pageNumber of pageNumbers) {
      const page = await pdf.getPage(pageNumber);
      const scale = 1.5;
      const viewport = page.getViewport({ scale });
      const width = Math.ceil(viewport.width); const height = Math.ceil(viewport.height);
      const canvas = createCanvas(width, height);
      const context = canvas.getContext("2d");
      context.fillStyle = "white"; context.fillRect(0, 0, width, height);
      await page.render({ canvasContext: context as never, viewport, canvas: canvas as never }).promise;
      const pixels = context.getImageData(0, 0, width, height).data;
      if (analyzeScannedOmr(pixels, width, height, scale, texts.get(pageNumber) ?? "").structural) found.add(pageNumber);
      page.cleanup();
    }
  } finally { await task.destroy(); }
  return found;
}
