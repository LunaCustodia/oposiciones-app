import type { OcrPageExtraction } from "../shared/ocr-extraction.js";

interface Word { value: string; start: number; end: number }
const cleanSourceText = (value: string) => value.replace(/-\s*\r?\n\s*/gu, "").replace(/\s+/gu, " ").trim();

function words(text: string): Word[] {
  const raw = [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
    value: match[0].normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("es"),
    start: match.index!, end: match.index! + match[0].length,
  }));
  const joined: Word[] = [];
  for (const word of raw) {
    const previous = joined.at(-1);
    if (previous && /^-\s*\r?\n\s*$/u.test(text.slice(previous.end, word.start))) {
      previous.value += word.value;
      previous.end = word.end;
    } else joined.push(word);
  }
  return joined;
}

// Return characters from OCR-03, never the model's reworded version. Formatting,
// line wrapping, case and accents may differ, but every word must match in order.
export function groundedSpan(value: string, source: string): { text: string; start: number; end: number } | null {
  const sought = words(value);
  const available = words(source);
  if (!sought.length) return null;
  for (let i = 0; i <= available.length - sought.length; i += 1) {
    if (sought.some((word, offset) => word.value !== available[i + offset]!.value)) continue;
    let start = available[i]!.start;
    let end = available[i + sought.length - 1]!.end;
    const prefix = value.slice(0, sought[0]!.start);
    const suffix = value.slice(sought.at(-1)!.end);
    if (/^[¿¡("'\s]+$/u.test(prefix) && source.slice(start - prefix.length, start) === prefix) start -= prefix.length;
    if (/^[.?!:;,)"'\s]+$/u.test(suffix) && source.slice(end, end + suffix.length) === suffix) end += suffix.length;
    return { text: cleanSourceText(source.slice(start, end)), start, end };
  }
  return null;
}

interface RecoveredQuestion {
  statement: string;
  options: Array<{ letter: string; text: string }>;
  pages: number[];
}

const questionHeader = /^\s*(?:pregunta\s+)?\d{1,3}\s*[.º°):\-]+\s*/iu;
const optionHeader = /^\s*([A-E])\s*[).:\-]+\s*(\S.*)$/iu;

// A conservative fallback for digital PDFs: only a unique numbered question
// and at least two distinct, explicitly labelled options are accepted.
export function recoverQuestionFromSource(pages: OcrPageExtraction[], startPage: number, printedNumber: string | null): RecoveredQuestion | null {
  if (!printedNumber || !/^\d{1,3}$/u.test(printedNumber.trim())) return null;
  const first = pages.find((page) => page.pageNumber === startPage);
  if (!first) return null;
  const number = String(Number(printedNumber));
  const header = new RegExp(`^\\s*(?:pregunta\\s+)?0*${number}\\s*[.º°):\\-]+\\s*`, "iu");
  const firstLines = first.text.split(/\r?\n/u);
  const starts = firstLines.flatMap((line, index) => header.test(line) ? [index] : []);
  if (starts.length !== 1) return null;
  const lines: Array<{ text: string; page: number }> = [];
  const next = pages.find((page) => page.pageNumber === startPage + 1);
  let stopped = false;
  for (const page of [first, next].filter((item): item is OcrPageExtraction => Boolean(item))) {
    if (stopped) break;
    const pageLines = page.text.split(/\r?\n/u);
    for (let index = page.pageNumber === startPage ? starts[0]! : 0; index < pageLines.length; index += 1) {
      const line = pageLines[index]!;
      if (lines.length && (questionHeader.test(line)
        || /^\s*(?:plantilla|respuestas|preguntas?\s+de\s+reserva|reservas?)\b/iu.test(line)
        || /^\s*p[aá]gina\s+\d+(?:\s+de\s+\d+)?\s*$/iu.test(line))) {
        stopped = true;
        break;
      }
      lines.push({ text: lines.length === 0 ? line.replace(header, "") : line, page: page.pageNumber });
    }
    if (lines.filter((line) => optionHeader.test(line.text)).length >= 4) stopped = true;
  }
  const optionStarts = lines.flatMap((line, index) => optionHeader.test(line.text) ? [index] : []);
  if (optionStarts.length < 2) return null;
  const options = optionStarts.map((start, index) => {
    const firstOption = lines[start]!.text.match(optionHeader)!;
    const end = optionStarts[index + 1] ?? lines.length;
    return { letter: firstOption[1]!.toUpperCase(), text: cleanSourceText([firstOption[2]!, ...lines.slice(start + 1, end).map((line) => line.text)]
      .join("\n")) };
  });
  if (new Set(options.map((option) => option.letter)).size !== options.length || options.some((option) => !option.text)) return null;
  const statement = cleanSourceText(lines.slice(0, optionStarts[0]).map((line) => line.text).join("\n"));
  if (statement.replace(/\s/gu, "").length < 8 || statement.length > 10_000) return null;
  return { statement, options, pages: [...new Set(lines.map((line) => line.page))] };
}
