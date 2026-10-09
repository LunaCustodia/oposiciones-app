import { get, put } from "@vercel/blob";
import { HTTPError } from "nitro";
import type { OcrAnswerEvidence } from "../shared/ocr-binding.js";
import type { ReviewDraft, ReviewDestination, ReviewQuestionValue, ReviewView } from "../shared/ocr-review.js";
import { readBindingResult } from "./ocr-binding.js";
import { readImport } from "./ocr-imports.js";
import { readInterpretationResult } from "./ocr-interpretation.js";

const reviewPath = (owner: string, id: string) => `ocr02/imports/${owner}/${id}/review/draft.json`;
const bad = (message: string) => { throw new HTTPError(message, { status: 400 }); };

export async function readReviewDraft(owner: string, id: string): Promise<ReviewDraft | null> {
  const blob = await get(reviewPath(owner, id), { access: "private", useCache: false });
  if (!blob?.stream || blob.statusCode !== 200) return null;
  try {
    const draft = JSON.parse(await new Response(blob.stream).text()) as ReviewDraft;
    return draft.ownerId === owner && draft.importId === id ? draft : null;
  } catch { return null; }
}

async function writeDraft(owner: string, id: string, draft: ReviewDraft): Promise<void> {
  await put(reviewPath(owner, id), JSON.stringify(draft), {
    access: "private", addRandomSuffix: false, allowOverwrite: true,
    cacheControlMaxAge: 60, contentType: "application/json",
  });
}

function text(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || value.length > max) bad(`${label} no es válido`);
  return value as string;
}

export function validateValue(raw: unknown): ReviewQuestionValue {
  if (!raw || typeof raw !== "object") bad("Pregunta no válida");
  const v = raw as Record<string, unknown>;
  if (!["ordinaria", "reserva", "desconocida"].includes(String(v.section))) bad("Sección no válida");
  if (!["respuesta", "anulada", "pendiente"].includes(String(v.resolution))) bad("Resolución no válida");
  if (!Array.isArray(v.options) || v.options.length > 26) bad("Opciones no válidas");
  if (!Array.isArray(v.subparts) || v.subparts.length > 30) bad("Apartados no válidos");
  if (!Array.isArray(v.tables) || v.tables.length > 20) bad("Tablas no válidas");
  const options = (v.options as unknown[]).map((option: unknown) => {
    if (!option || typeof option !== "object") bad("Opción no válida");
    const item = option as Record<string, unknown>;
    return { letter: text(item.letter, 4, "Letra"), text: text(item.text, 10_000, "Opción") };
  });
  const subparts = (v.subparts as unknown[]).map((part: unknown) => {
    if (!part || typeof part !== "object") bad("Apartado no válido");
    const item = part as Record<string, unknown>;
    return { label: text(item.label, 30, "Etiqueta"), text: text(item.text, 20_000, "Apartado") };
  });
  const tables = (v.tables as unknown[]).map((table: unknown) => {
    if (!table || typeof table !== "object") bad("Tabla no válida");
    const item = table as Record<string, unknown>;
    if (!Array.isArray(item.rows) || item.rows.length > 100 || item.rows.some((row: unknown) => !Array.isArray(row) || row.length > 30 || row.some((cell: unknown) => typeof cell !== "string" || cell.length > 2_000))) bad("Tabla no válida");
    return { text: text(item.text, 20_000, "Tabla"), rows: item.rows as string[][] };
  });
  return {
    number: text(v.number, 30, "Número"), section: v.section as ReviewQuestionValue["section"],
    statement: text(v.statement, 50_000, "Enunciado"), subparts, options, tables,
    answer: v.answer === null ? null : text(v.answer, 4, "Respuesta"),
    resolution: v.resolution as ReviewQuestionValue["resolution"],
  };
}

export async function reviewContext(owner: string, id: string) {
  const manifest = await readImport(owner, id);
  if (!manifest) throw new HTTPError("Importación no encontrada", { status: 404 });
  const [interpretation, binding] = await Promise.all([readInterpretationResult(owner, id), readBindingResult(owner, id)]);
  if (!interpretation || !binding) throw new HTTPError("La interpretación y vinculación deben estar terminadas", { status: 409 });
  if (interpretation.questions.length === 0) throw new HTTPError("No hay preguntas para revisar", { status: 409 });
  return { manifest, interpretation, binding };
}

function freshDraft(owner: string, id: string, fingerprint: string): ReviewDraft {
  return { ownerId: owner, importId: id, fingerprint, destination: "oficiales", corrections: {}, orphans: {}, imported: null, updatedAt: new Date().toISOString() };
}

export async function loadDraft(owner: string, id: string, fingerprint: string): Promise<ReviewDraft> {
  const draft = await readReviewDraft(owner, id);
  return draft?.fingerprint === fingerprint ? draft : freshDraft(owner, id, fingerprint);
}

export async function saveReviewChange(owner: string, id: string, raw: unknown): Promise<ReviewView> {
  const { binding } = await reviewContext(owner, id);
  const draft = await loadDraft(owner, id, binding.fingerprint);
  if (draft.imported) throw new HTTPError("El examen ya está importado", { status: 409 });
  if (!raw || typeof raw !== "object") bad("Cambio no válido");
  const input = raw as Record<string, unknown>;
  const now = new Date().toISOString();
  if (input.kind === "question") {
    const view = await getReview(owner, id);
    const question = view.questions.find((item) => item.id === input.questionId);
    if (!question) bad("Pregunta no encontrada");
    const evidenceId = input.evidenceId === null ? null : text(input.evidenceId, 128, "Evidencia");
    if (evidenceId && !question!.evidence.some((item) => item.id === evidenceId)) bad("Evidencia ajena a la pregunta");
    draft.corrections[question!.id] = { value: validateValue(input.value), correctedAt: now, evidenceId };
  } else if (input.kind === "orphan") {
    const orphan = binding.orphans.find((item) => item.id === input.evidenceId);
    if (!orphan) bad("Respuesta huérfana no encontrada");
    if (input.action !== "associate" && input.action !== "discard") bad("Decisión no válida");
    const questionId = input.action === "associate" ? text(input.questionId, 128, "Pregunta") : null;
    if (questionId && !binding.bindings.some((item) => item.questionId === questionId)) bad("Pregunta no encontrada");
    draft.orphans[orphan!.id] = { action: input.action as "associate" | "discard", questionId, decidedAt: now, evidenceId: orphan!.id };
  } else if (input.kind === "destination") {
    if (input.destination !== "oficiales" && input.destination !== "otros") bad("Destino no válido");
    draft.destination = input.destination as ReviewDestination;
  } else bad("Cambio no válido");
  draft.updatedAt = now;
  await writeDraft(owner, id, draft);
  return getReview(owner, id);
}

export function validateReview(view: ReviewView): ReviewView["blockers"] {
  const blockers: ReviewView["blockers"] = [];
  const seen = new Set<string>();
  for (const question of view.questions) {
    const v = question.value;
    const add = (message: string) => blockers.push({ questionId: question.id, message: `${v.section} ${v.number || "sin número"}: ${message}` });
    if (!v.number.trim()) add("falta el número");
    if (v.section === "desconocida") add("falta elegir sección");
    const key = `${v.section}:${v.number.trim().toLowerCase()}`;
    if (v.number.trim() && v.section !== "desconocida") {
      if (seen.has(key)) add("número y sección duplicados");
      seen.add(key);
    }
    if (!v.statement.trim()) add("enunciado vacío");
    const validOptions = v.options.filter((option) => option.letter.trim() && option.text.trim());
    if (validOptions.length < 2 || validOptions.length !== v.options.length) add("se necesitan al menos dos opciones válidas");
    const letters = validOptions.map((option) => option.letter.trim().toUpperCase());
    if (letters.some((letter) => !/^[A-Z]$/u.test(letter))) add("cada letra de opción debe ser una sola letra A-Z");
    if (new Set(letters).size !== letters.length) add("letras de opciones duplicadas");
    if (v.resolution === "pendiente") add("conflicto, ambigüedad o respuesta pendiente");
    if (v.resolution === "respuesta" && (!v.answer || !letters.includes(v.answer.trim().toUpperCase()))) add("respuesta correcta ausente o fuera de las opciones");
    if (v.resolution === "anulada" && v.answer) add("una pregunta anulada no puede tener respuesta correcta");
  }
  for (const orphan of view.orphans) if (!orphan.decision) blockers.push({ questionId: null, message: `Respuesta huérfana ${orphan.evidence.printedNumber || orphan.evidence.id}: asociar o descartar` });
  return blockers;
}

export async function getReview(owner: string, id: string): Promise<ReviewView> {
  const { manifest, interpretation, binding } = await reviewContext(owner, id);
  const draft = await loadDraft(owner, id, binding.fingerprint);
  const questions = interpretation.questions.map((source) => {
    const match = binding.bindings.find((item) => item.questionId === source.id);
    const detected: ReviewQuestionValue = {
      number: source.printedNumber || "", section: source.section, statement: source.statement,
      subparts: source.subparts, options: source.options, tables: source.tables,
      answer: match?.state === "vinculada" ? match.answer : null,
      resolution: match?.state === "vinculada" ? "respuesta" : match?.state === "anulada" ? "anulada" : "pendiente",
    };
    const corrected = draft.corrections[source.id] || null;
    const associated = binding.orphans.filter((evidence) => draft.orphans[evidence.id]?.questionId === source.id);
    const evidence: OcrAnswerEvidence[] = [...(match?.sources || []), ...associated];
    return { id: source.id, detected, corrected, value: corrected?.value || detected, source,
      evidence, initialState: match?.state || "sin_respuesta", issues: source.issues };
  });
  const view: ReviewView = { importId: id, metadata: manifest.metadata, destination: draft.destination, questions,
    orphans: binding.orphans.map((evidence) => ({ evidence, decision: draft.orphans[evidence.id] || null })),
    blockers: [], updatedAt: draft.updatedAt, imported: draft.imported };
  view.blockers = validateReview(view);
  return view;
}

export async function markImported(owner: string, id: string, fingerprint: string, examId: string, destination: ReviewDestination): Promise<void> {
  const draft = await loadDraft(owner, id, fingerprint);
  draft.imported = { examId, destination };
  draft.updatedAt = new Date().toISOString();
  await writeDraft(owner, id, draft);
}
