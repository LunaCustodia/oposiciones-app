import type { OcrAnswerEvidence, OcrBindingCounts, OcrQuestionBinding } from "../shared/ocr-binding.js";
import type { OcrQuestionCandidate, OcrSemanticSection } from "../shared/ocr-interpretation.js";

export function normalizePrintedNumber(value: string | null): string | null {
  if (!value) return null;
  const clean = value.trim().replace(/[.º°):\s]+$/u, "");
  return /^\d+$/.test(clean) ? String(Number(clean)) : null;
}

function key(section: OcrSemanticSection, number: string): string { return `${section}:${number}`; }

export function linkAnswers(questions: OcrQuestionCandidate[], evidence: OcrAnswerEvidence[]): {
  bindings: OcrQuestionBinding[]; orphans: OcrAnswerEvidence[]; counts: OcrBindingCounts;
} {
  const byKey = new Map<string, OcrQuestionCandidate[]>();
  const byNumber = new Map<string, OcrQuestionCandidate[]>();
  for (const question of questions) {
    const number = normalizePrintedNumber(question.printedNumber);
    if (!number) continue;
    const exact = key(question.section, number);
    byKey.set(exact, [...byKey.get(exact) ?? [], question]);
    byNumber.set(number, [...byNumber.get(number) ?? [], question]);
  }
  const assigned = new Map<string, OcrAnswerEvidence[]>();
  const orphans: OcrAnswerEvidence[] = [];
  for (const source of evidence) {
    const number = normalizePrintedNumber(source.printedNumber);
    if (!number) { orphans.push(source); continue; }
    const matches = source.section === "desconocida"
      ? byNumber.get(number) ?? []
      : byKey.get(key(source.section, number)) ?? [];
    if (matches.length !== 1) { orphans.push(source); continue; }
    const id = matches[0]!.id;
    assigned.set(id, [...assigned.get(id) ?? [], source]);
  }
  const bindings: OcrQuestionBinding[] = questions.map((question) => {
    const sources = assigned.get(question.id) ?? [];
    const strong = sources.filter((source) => !source.ambiguous && source.confidence >= 0.75);
    const values = new Set(strong.map((source) => source.annulled ? "ANULAR" : source.answer).filter(Boolean));
    let state: OcrQuestionBinding["state"] = "sin_respuesta";
    let answer: string | null = null;
    let reason: string | null = null;
    if (values.size > 1 || sources.some((source) => source.issues.includes("doble_marca"))) {
      state = "conflicto"; reason = values.size > 1 ? "fuentes_incompatibles" : "doble_marca";
    } else if (sources.some((source) => source.ambiguous || source.confidence < 0.75) || (sources.length > 0 && !values.size)) {
      state = "ambigua"; reason = "evidencia_insuficiente";
    } else if (values.has("ANULAR")) {
      state = "anulada";
    } else if (values.size === 1) {
      state = "vinculada"; answer = [...values][0]!;
    }
    return { questionId: question.id, printedNumber: question.printedNumber, section: question.section,
      questionFileId: question.fileId, questionPages: question.pages, state, answer, sources, reason };
  });
  const counts: OcrBindingCounts = {
    linked: bindings.filter((item) => item.state === "vinculada").length,
    annulled: bindings.filter((item) => item.state === "anulada").length,
    unanswered: bindings.filter((item) => item.state === "sin_respuesta").length,
    ambiguous: bindings.filter((item) => item.state === "ambigua").length,
    conflicts: bindings.filter((item) => item.state === "conflicto").length,
    orphans: orphans.length,
  };
  return { bindings, orphans, counts };
}
