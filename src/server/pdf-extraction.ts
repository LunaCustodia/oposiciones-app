import { createHash } from "node:crypto";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import "pdfjs-dist/legacy/build/pdf.worker.mjs";
import type {
  OcrBoundingBox,
  OcrExtractionFileCache,
  OcrLayoutElement,
  OcrPageExtraction,
  OcrPageQuality,
  OcrPreparedFile,
} from "../shared/ocr-extraction.js";
import {
  isFileCacheComplete,
  readExtractionStatus,
  readFileCache,
  readPrivateImportPdf,
  updateFileProgress,
  writeFileCache,
  writePageExtraction,
} from "./ocr-extractions.js";

export const DIRECT_TEXT_CRITERIA = {
  minVisibleCharacters: 40,
  minWords: 6,
  maxIllegalCharacterRatio: 0.02,
  maxSingleCharacterTokenRatio: 0.7,
  maxSourceOrderDiscontinuityRatio: 0.35,
} as const;

interface RawToken {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LineGroup {
  y: number;
  height: number;
  tokens: RawToken[];
}

function boxForToken(token: RawToken): OcrBoundingBox {
  return {
    coordinateSystem: "pdf_points_bottom_left",
    vertices: [
      { x: token.x, y: token.y },
      { x: token.x + token.width, y: token.y },
      { x: token.x + token.width, y: token.y + token.height },
      { x: token.x, y: token.y + token.height },
    ],
  };
}

function unionBox(tokens: RawToken[]): OcrBoundingBox[] {
  if (tokens.length === 0) return [];
  const minX = Math.min(...tokens.map((token) => token.x));
  const minY = Math.min(...tokens.map((token) => token.y));
  const maxX = Math.max(...tokens.map((token) => token.x + token.width));
  const maxY = Math.max(...tokens.map((token) => token.y + token.height));
  return [{
    coordinateSystem: "pdf_points_bottom_left",
    vertices: [
      { x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY },
    ],
  }];
}

function splitTextItem(item: Record<string, unknown>): RawToken[] {
  const text = typeof item.str === "string" ? item.str : "";
  const transform = Array.isArray(item.transform) ? item.transform.map(Number) : [];
  const x = Number.isFinite(transform[4]) ? transform[4]! : 0;
  const y = Number.isFinite(transform[5]) ? transform[5]! : 0;
  const width = Number.isFinite(Number(item.width)) ? Math.abs(Number(item.width)) : Math.max(1, text.length * 5);
  const height = Number.isFinite(Number(item.height)) && Number(item.height) > 0
    ? Number(item.height)
    : Math.max(1, Math.abs(transform[3] ?? 10));
  const matches = [...text.matchAll(/\S+/gu)];
  return matches.map((match) => {
    const start = match.index ?? 0;
    const tokenWidth = width * (match[0].length / Math.max(1, text.length));
    return {
      text: match[0],
      x: x + width * (start / Math.max(1, text.length)),
      y,
      width: Math.max(0.5, tokenWidth),
      height,
    };
  });
}

function groupLines(tokens: RawToken[]): LineGroup[] {
  const sorted = [...tokens].sort((left, right) => Math.abs(right.y - left.y) > 2 ? right.y - left.y : left.x - right.x);
  const lines: LineGroup[] = [];
  for (const token of sorted) {
    const line = lines.find((candidate) => Math.abs(candidate.y - token.y) <= Math.max(2, Math.min(candidate.height, token.height) * 0.45));
    if (line) {
      line.tokens.push(token);
      line.y = (line.y + token.y) / 2;
      line.height = Math.max(line.height, token.height);
    } else {
      lines.push({ y: token.y, height: token.height, tokens: [token] });
    }
  }
  return lines
    .sort((left, right) => right.y - left.y)
    .map((line) => ({ ...line, tokens: line.tokens.sort((left, right) => left.x - right.x) }));
}

function lineText(line: LineGroup): string {
  return line.tokens.map((token) => token.text).join(" ").trim();
}

function layoutElement(id: string, text: string, order: number, tokens: RawToken[]): OcrLayoutElement {
  return { id, text, order, confidence: null, boundingBoxes: unionBox(tokens) };
}

function paragraphGroups(lines: LineGroup[]): LineGroup[][] {
  if (lines.length === 0) return [];
  const groups: LineGroup[][] = [[lines[0]!]];
  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1]!;
    const current = lines[index]!;
    const gap = previous.y - current.y;
    if (gap > Math.max(12, Math.max(previous.height, current.height) * 1.8)) groups.push([current]);
    else groups.at(-1)!.push(current);
  }
  return groups;
}

function illegalCharacterRatio(text: string): number {
  if (!text) return 0;
  return (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/g)?.length ?? 0) / text.length;
}

function directQuality(text: string, rawTokens: RawToken[], lineCount: number, discontinuityRatio: number): {
  quality: OcrPageQuality;
  reasons: string[];
} {
  const visibleCharacters = text.replace(/\s/g, "").length;
  const wordCount = rawTokens.length;
  const illegalRatio = illegalCharacterRatio(text);
  const singleRatio = wordCount > 0 ? rawTokens.filter((token) => token.text.length === 1).length / wordCount : 0;
  const reasons: string[] = [];
  if (visibleCharacters === 0) reasons.push("empty_text");
  else if (visibleCharacters < DIRECT_TEXT_CRITERIA.minVisibleCharacters || wordCount < DIRECT_TEXT_CRITERIA.minWords) reasons.push("insufficient_text");
  if (illegalRatio > DIRECT_TEXT_CRITERIA.maxIllegalCharacterRatio) reasons.push("illegible_characters");
  if (singleRatio > DIRECT_TEXT_CRITERIA.maxSingleCharacterTokenRatio && wordCount >= 10) reasons.push("fragmented_text");
  if (lineCount === 0) reasons.push("insufficient_structure");
  if (discontinuityRatio > DIRECT_TEXT_CRITERIA.maxSourceOrderDiscontinuityRatio) reasons.push("reading_order_inconsistent");
  const score = Math.max(0, Math.min(1,
    (Math.min(1, visibleCharacters / 120) * 0.35)
    + (Math.min(1, wordCount / 18) * 0.25)
    + ((1 - Math.min(1, illegalRatio * 10)) * 0.2)
    + ((1 - Math.min(1, discontinuityRatio)) * 0.2),
  ));
  return {
    quality: {
      valid: reasons.length === 0,
      score,
      visibleCharacters,
      wordCount,
      illegalCharacterRatio: illegalRatio,
      singleCharacterTokenRatio: singleRatio,
      sourceOrderDiscontinuityRatio: discontinuityRatio,
    },
    reasons,
  };
}

function sourceDiscontinuity(items: Array<Record<string, unknown>>): number {
  const positions = items.map((item) => {
    const transform = Array.isArray(item.transform) ? item.transform.map(Number) : [];
    return { y: transform[5] ?? 0, height: Math.max(1, Math.abs(transform[3] ?? 10)) };
  });
  if (positions.length < 2) return 0;
  let jumps = 0;
  for (let index = 1; index < positions.length; index += 1) {
    const previous = positions[index - 1]!;
    const current = positions[index]!;
    if (current.y > previous.y + Math.max(previous.height, current.height) * 2) jumps += 1;
  }
  return jumps / (positions.length - 1);
}

function directPageResult(input: {
  importId: string;
  fileId: string;
  originalName: string;
  fileOrder: number;
  pageNumber: number;
  sourceSha256: string;
  items: Array<Record<string, unknown>>;
}): { result: OcrPageExtraction; reasons: string[] } {
  const rawTokens = input.items.flatMap(splitTextItem);
  const linesGrouped = groupLines(rawTokens);
  const lineElements = linesGrouped.map((line, order) => layoutElement(`line-${order + 1}`, lineText(line), order, line.tokens));
  const paragraphsGrouped = paragraphGroups(linesGrouped);
  const paragraphElements = paragraphsGrouped.map((lines, order) => {
    const tokens = lines.flatMap((line) => line.tokens);
    return layoutElement(`paragraph-${order + 1}`, lines.map(lineText).join("\n"), order, tokens);
  });
  const blockElements = paragraphsGrouped.map((lines, order) => {
    const tokens = lines.flatMap((line) => line.tokens);
    return layoutElement(`block-${order + 1}`, lines.map(lineText).join("\n"), order, tokens);
  });
  const tokenElements = rawTokens.map((token, order) => ({
    id: `token-${order + 1}`,
    text: token.text,
    order,
    confidence: null,
    boundingBoxes: [boxForToken(token)],
  } satisfies OcrLayoutElement));
  const text = lineElements.map((line) => line.text).join("\n").trim();
  const evaluated = directQuality(text, rawTokens, lineElements.length, sourceDiscontinuity(input.items));
  return {
    reasons: evaluated.reasons,
    result: {
      importId: input.importId,
      fileId: input.fileId,
      originalName: input.originalName,
      fileOrder: input.fileOrder,
      pageNumber: input.pageNumber,
      method: "direct",
      text,
      blocks: blockElements,
      paragraphs: paragraphElements,
      lines: lineElements,
      tokens: tokenElements,
      readingOrder: {
        blocks: blockElements.map((item) => item.id),
        paragraphs: paragraphElements.map((item) => item.id),
        lines: lineElements.map((item) => item.id),
        tokens: tokenElements.map((item) => item.id),
      },
      quality: evaluated.quality,
      documentAiReason: null,
      issues: evaluated.reasons,
      sourceSha256: input.sourceSha256,
      extractedAt: new Date().toISOString(),
    },
  };
}

export async function preparePdfExtraction(ownerId: string, importId: string, fileId: string): Promise<OcrPreparedFile> {
  const { file, bytes } = await readPrivateImportPdf(ownerId, importId, fileId);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const cached = await readFileCache(ownerId, importId, fileId);
  if (cached?.sha256 === sha256 && await isFileCacheComplete(ownerId, cached)) {
    await updateFileProgress(ownerId, importId, fileId, {
      state: cached.state,
      totalPages: cached.pageCount,
      processedPages: cached.pageCount,
      directPages: cached.directPages,
      documentAiPages: cached.documentAiPages,
      errorPages: cached.errorPages,
      currentPage: null,
    });
    return { fileId, sha256, pageCount: cached.pageCount, cached: true, fallbackPages: [] };
  }

  const task = getDocument({ data: bytes, useSystemFonts: true });
  const document = await task.promise;
  const pageCount = document.numPages;
  const fallbackPages: OcrPreparedFile["fallbackPages"] = [];
  let directPages = 0;
  await updateFileProgress(ownerId, importId, fileId, {
    state: "procesando",
    totalPages: pageCount,
    processedPages: 0,
    directPages: 0,
    documentAiPages: 0,
    errorPages: [],
    currentPage: 1,
  });

  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
      const items = content.items.filter((item) => "str" in item) as unknown as Record<string, unknown>[];
      const evaluated = directPageResult({
        importId,
        fileId,
        originalName: file.originalName,
        fileOrder: file.order,
        pageNumber,
        sourceSha256: sha256,
        items,
      });
      if (evaluated.result.quality.valid) {
        await writePageExtraction(ownerId, evaluated.result);
        directPages += 1;
        await updateFileProgress(ownerId, importId, fileId, {
          processedPages: directPages,
          directPages,
          currentPage: pageNumber < pageCount ? pageNumber + 1 : null,
        });
      } else {
        fallbackPages.push({ pageNumber, reason: evaluated.reasons.join(",") || "insufficient_text" });
        await updateFileProgress(ownerId, importId, fileId, { currentPage: pageNumber });
      }
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }

  if (fallbackPages.length === 0) {
    const completedAt = new Date().toISOString();
    const cache: OcrExtractionFileCache = {
      importId,
      fileId,
      sha256,
      pageCount,
      state: "completado",
      directPages,
      documentAiPages: 0,
      errorPages: [],
      completedAt,
    };
    await writeFileCache(ownerId, cache);
    await updateFileProgress(ownerId, importId, fileId, {
      state: "completado",
      processedPages: pageCount,
      currentPage: null,
    });
  }

  return { fileId, sha256, pageCount, cached: false, fallbackPages };
}

export async function completePreparedFile(
  ownerId: string,
  importId: string,
  fileId: string,
  sha256: string,
  pageCount: number,
): Promise<void> {
  const status = await readExtractionStatus(ownerId, importId);
  const file = status?.files.find((candidate) => candidate.fileId === fileId);
  if (!file) throw new Error("extraction_file_progress_not_found");
  const state = file.errorPages.length > 0 ? "revision" : "completado";
  await updateFileProgress(ownerId, importId, fileId, {
    state,
    processedPages: pageCount,
    currentPage: null,
  });
  await writeFileCache(ownerId, {
    importId,
    fileId,
    sha256,
    pageCount,
    state,
    directPages: file.directPages,
    documentAiPages: file.documentAiPages,
    errorPages: file.errorPages,
    completedAt: new Date().toISOString(),
  });
}
