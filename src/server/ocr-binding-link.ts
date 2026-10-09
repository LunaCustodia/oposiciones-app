import type { OcrAnswerEvidence, OcrBindingCounts, OcrQuestionBinding } from "../shared/ocr-binding.js";
import type { OcrQuestionCandidate, OcrSemanticSection } from "../shared/ocr-interpretation.js";

export function normalizePrintedNumber(value: string | null): string | null {
  if (!value) return null;
  const clean = value.trim().replace(/[.º°):\s]+$/u, "");
  return /^\d+$/.test(clean) ? String(Number(clean)) : null;
}

function key(section: OcrSemanticSection, number: string): string { return `${section}:${number}`; }

// OCR-04 preserves the detected text unchanged. For linking only, a damaged
// printed digit can be recovered when the entire section is a verified,
// ordered 1..N sequence with enough legible anchors. Otherwise leave it open.
export function recoverSequentialNumbers(questions: OcrQuestionCandidate[]): OcrQuestionCandidate[] {
  const recovered = [...questions];
  for (const section of ["ordinaria", "reserva"] as const) {
    const indexes = questions.flatMap((question, index) => question.section === section ? [index] : []);
    if (indexes.length < 3) continue;
    const known = indexes.filter((index, position) => normalizePrintedNumber(questions[index]!.printedNumber) === String(position + 1));
    const mismatched = indexes.some((index, position) => {
      const number = normalizePrintedNumber(questions[index]!.printedNumber);
      return number !== null && number !== String(position + 1);
    });
    if (mismatched || known.length < Math.max(3, Math.ceil(indexes.length * 0.75))) continue;
    const pages = indexes.map((index) => questions[index]!.pages[0] ?? 0);
    if (pages.some((page, index) => index > 0 && page < pages[index - 1]!)) continue;
    for (const [position, index] of indexes.entries()) {
      if (normalizePrintedNumber(questions[index]!.printedNumber) !== null) continue;
      recovered[index] = { ...questions[index]!, printedNumber: String(position + 1) };
    }
  }
  return recovered;
}

export function linkAnswers(questions: OcrQuestionCandidate[], evidence: OcrAnswerEvidence[]): {
  bindings: OcrQuestionBinding[]; orphans: OcrAnswerEvidence[]; counts: OcrBindingCounts;
} {
  const linkedQuestions = recoverSequentialNumbers(questions);
  const inferredQuestionIds = new Set(linkedQuestions.filter((question, index) => question.printedNumber !== questions[index]!.printedNumber)
    .map((question) => question.id));
  const byKey = new Map<string, OcrQuestionCandidate[]>();
  const byNumber = new Map<string, OcrQuestionCandidate[]>();
  for (const question of linkedQuestions) {
    const number = normalizePrintedNumber(question.printedNumber);
    if (!number) continue;
    const exact = key(question.section, number);
    byKey.set(exact, [...byKey.get(exact) ?? [], question]);
    byNumber.set(number, [...byNumber.get(number) ?? [], question]);
  }
  const sectionByPage = new Map<string, OcrSemanticSection>();
  const pageGroups = new Map<string, OcrAnswerEvidence[]>();
  for (const source of evidence) {
    const pageKey = `${source.fileId}:${source.page}`;
    pageGroups.set(pageKey, [...pageGroups.get(pageKey) ?? [], source]);
  }
  for (const [pageKey, sources] of pageGroups) {
    const sections = new Set<OcrSemanticSection>();
    let unambiguous = 0;
    for (const source of sources) {
      if (source.section !== "desconocida") { sections.add(source.section); continue; }
      const number = normalizePrintedNumber(source.printedNumber);
      const matches = number ? byNumber.get(number) ?? [] : [];
      if (matches.length === 1 && matches[0]!.section !== "desconocida") {
        sections.add(matches[0]!.section);
        unambiguous += 1;
      }
    }
    if (sections.size === 1 && (unambiguous >= 2 || sources.some((source) => source.section !== "desconocida"))) {
      sectionByPage.set(pageKey, [...sections][0]!);
    }
  }
  const assigned = new Map<string, OcrAnswerEvidence[]>();
  const orphans: OcrAnswerEvidence[] = [];
  for (const raw of evidence) {
    const inferred = raw.section === "desconocida" ? sectionByPage.get(`${raw.fileId}:${raw.page}`) : null;
    const source = inferred ? { ...raw, section: inferred, issues: [...raw.issues, "seccion_inferida_por_bloque"] } : raw;
    const number = normalizePrintedNumber(source.printedNumber);
    if (!number) { orphans.push(source); continue; }
    const matches = source.section === "desconocida"
      ? byNumber.get(number) ?? []
      : byKey.get(key(source.section, number)) ?? [];
    if (matches.length !== 1) { orphans.push(source); continue; }
    const id = matches[0]!.id;
    assigned.set(id, [...assigned.get(id) ?? [], inferredQuestionIds.has(id)
      ? { ...source, issues: [...source.issues, "numero_pregunta_inferido_por_secuencia"] } : source]);
  }
  const bindings: OcrQuestionBinding[] = linkedQuestions.map((question) => {
    const sources = assigned.get(question.id) ?? [];
    const strong = sources.filter((source) => !source.ambiguous && source.confidence >= 0.75);
    const values = new Set(strong.map((source) => source.annulled ? "ANULAR" : source.answer).filter(Boolean));
    let state: OcrQuestionBinding["state"] = "sin_respuesta";
    let answer: string | null = null;
    let reason: string | null = null;
    if (values.size > 1 || sources.some((source) => source.issues.includes("opciones_distintas") || source.issues.includes("doble_marca"))) {
      state = "conflicto"; reason = values.size > 1 ? "fuentes_incompatibles" : "opciones_distintas";
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
  const rowKeys = new Set([...bindings.flatMap((binding) => binding.sources), ...orphans]
    .map((source) => `${source.fileId}:${source.page}:${source.section}:${normalizePrintedNumber(source.printedNumber) ?? source.id}`));
  const counts: OcrBindingCounts = {
    questions: questions.length,
    answerRows: rowKeys.size,
    associated: bindings.filter((item) => item.sources.length > 0).length,
    unequivocal: bindings.filter((item) => item.state === "vinculada" && !item.sources.some((source) => source.issues.includes("marca_duplicada"))).length,
    duplicateMarks: bindings.filter((item) => item.sources.some((source) => source.issues.includes("marca_duplicada"))).length,
    linked: bindings.filter((item) => item.state === "vinculada").length,
    annulled: bindings.filter((item) => item.state === "anulada").length,
    unanswered: bindings.filter((item) => item.state === "sin_respuesta").length,
    ambiguous: bindings.filter((item) => item.state === "ambigua").length,
    conflicts: bindings.filter((item) => item.state === "conflicto").length,
    orphans: orphans.length,
  };
  return { bindings, orphans, counts };
}
