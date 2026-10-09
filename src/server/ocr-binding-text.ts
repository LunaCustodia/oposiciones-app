import { createHash } from "node:crypto";
import type { OcrPageExtraction } from "../shared/ocr-extraction.js";
import type { OcrAnswerEvidence } from "../shared/ocr-binding.js";
import type { OcrAnswerCandidate, OcrSemanticSection } from "../shared/ocr-interpretation.js";

const answerPattern = /(?:^|\s)(\d{1,3})\s*[.):-]?\s*(ANULAR|ANULADA|ANULADO|[A-E])(?=\s|[,;.]|$)/giu;
const sectionPattern = /\b(?:preguntas?\s+de\s+)?reservas?\b/iu;
const ordinaryPattern = /\b(?:preguntas?\s+)?ordinarias?\b/iu;
const templatePattern = /\b(?:plantilla|soluciones|respuestas|clave\s+de\s+respuestas)\b/iu;

function id(parts: unknown[]): string { return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24); }

export function pageLooksLikeTemplate(page: OcrPageExtraction, manuallyAnswers: boolean, classifiedAnswers: boolean): boolean {
  if (manuallyAnswers || classifiedAnswers || templatePattern.test(page.text)) return true;
  const answerLines = page.text.split(/\r?\n/u).filter((line) => [...line.matchAll(answerPattern)].length >= 2);
  return answerLines.length >= 2;
}

export function parseTextualAnswers(page: OcrPageExtraction, initialSection: OcrSemanticSection): OcrAnswerEvidence[] {
  let section = initialSection;
  const output: OcrAnswerEvidence[] = [];
  const lines = page.text.split(/\r?\n/u);
  for (const [lineIndex, line] of lines.entries()) {
    if (sectionPattern.test(line)) section = "reserva";
    else if (ordinaryPattern.test(line)) section = "ordinaria";
    if (/\?/u.test(line) && !templatePattern.test(line)) continue;
    const matches = [...line.matchAll(answerPattern)];
    if (!matches.length) continue;
    const other = line.replace(answerPattern, "").replace(/[\s,;|.()\-:]/gu, "");
    const compactDouble = /^\s*\d{1,3}\s*[.):-]?\s*[A-E]\s+[A-E]\s*$/iu.test(line);
    if (matches.length === 1 && /(?:^|\s)[A-E](?=\s|$)/iu.test(line.replace(answerPattern, " ")) && !compactDouble) continue;
    if (other.length > 24 && !templatePattern.test(line)) continue;
    const format = matches.length > 1 || /[|]/u.test(line) ? "tabla" : "textual";
    const box = page.lines[lineIndex]?.boundingBoxes[0];
    const xs = box?.vertices.map((point) => point.x) ?? [];
    const ys = box?.vertices.map((point) => point.y) ?? [];
    const coordinates = box && xs.length && ys.length ? { coordinateSystem: box.coordinateSystem,
      x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) } : null;
    for (const [matchIndex, match] of matches.entries()) {
      const value = match[2]!.toUpperCase();
      const annulled = value.startsWith("ANUL");
      const next = matches[matchIndex + 1];
      const tail = line.slice((match.index ?? 0) + match[0].length, next?.index ?? line.length);
      const marks = annulled ? [] : [value,
        ...[...tail.matchAll(/\b[A-E]\b/giu)].map((item) => item[0].toUpperCase()),
        ...matches.filter((other, otherIndex) => otherIndex !== matchIndex && other[1] === match[1]
          && /^[A-E]$/iu.test(other[2]!)).map((item) => item[2]!.toUpperCase())];
      const options = new Set(marks);
      const duplicate = marks.length > 1 && options.size === 1;
      const incompatible = options.size > 1;
      const markScores = duplicate || incompatible ? Object.fromEntries("ABCDE".split("").map((letter) =>
        [letter, marks.filter((mark) => mark === letter).length])) : null;
      output.push({
        id: id([page.fileId, page.pageNumber, line, match.index, section]),
        printedNumber: match[1]!, section, answer: annulled || incompatible ? null : value,
        annulled, ambiguous: false, method: format, fileId: page.fileId,
        originalName: page.originalName, page: page.pageNumber, coordinates,
        imageId: null, confidence: 0.96, markScores, issues: incompatible ? ["opciones_distintas"] : duplicate ? ["marca_duplicada"] : [],
      });
    }
  }
  return output;
}

export function fromSemanticCandidates(answers: OcrAnswerCandidate[]): OcrAnswerEvidence[] {
  return answers.map((candidate) => {
    const unverified = candidate.issues.some((issue) => issue.includes("no_verificad") || issue === "formato_no_verificado");
    const annulled = candidate.state === "anulada";
    const answer = /^[A-E]$/iu.test(candidate.candidateAnswer ?? "") ? candidate.candidateAnswer!.toUpperCase() : null;
    return {
      id: candidate.id, printedNumber: candidate.printedNumber, section: candidate.section,
      answer: annulled ? null : answer, annulled,
      ambiguous: unverified || candidate.state === "ambigua" || candidate.state === "sin_determinar" || (!answer && !annulled),
      method: candidate.format === "tabla" ? "tabla" : candidate.format === "negrita" ? "negrita" : "textual",
      fileId: candidate.fileId, originalName: candidate.originalName, page: candidate.page,
      coordinates: null, imageId: null, confidence: unverified ? Math.min(0.5, candidate.confidence) : candidate.confidence,
      markScores: null, issues: candidate.issues,
    };
  });
}
