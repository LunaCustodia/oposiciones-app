import { createHash } from "node:crypto";
import { del, get, put } from "@vercel/blob";
import { HTTPError } from "nitro";
import type { OcrPageExtraction } from "../shared/ocr-extraction.js";
import type { OcrImportManifest } from "../shared/ocr-import.js";
import {
  OCR_INTERPRETATION_PROMPT_VERSION,
  OCR_INTERPRETATION_SCHEMA_VERSION,
  type OcrAnswerCandidate,
  type OcrInterpretationBlockRef,
  type OcrInterpretationCounts,
  type OcrInterpretationResult,
  type OcrInterpretationStatus,
  type OcrInterpretationView,
  type OcrQuestionCandidate,
  type OcrSemanticBlock,
} from "../shared/ocr-interpretation.js";
import { callGemini } from "./connections.js";
import { readExtractionStatus, readPageExtraction } from "./ocr-extractions.js";
import { groundedSpan, recoverQuestionFromSource } from "./ocr-interpretation-grounding.js";
import { OCR_INTERPRETATION_JSON_SCHEMA, parseWithSingleRepair, type ModelInterpretation } from "./ocr-interpretation-schema.js";

const MAX_CORE_PAGES = 1;
const ROOT = "ocr02/imports";

const PROMPT = `Interpreta exclusivamente el material OCR-03 adjunto. Copia literalmente los textos: no completes ni deduzcas palabras, números, opciones, respuestas o secciones que falten. Si falta algo, deja el campo vacío o nulo y marca una incidencia. Identifica preguntas ordinarias, reservas (aunque su numeración comience otra vez), apartados, opciones, tablas, candidatos de plantilla y anulaciones. NO relaciones respuestas con preguntas. Un enunciado puede continuar en la página siguiente; usa las páginas de contexto, pero devuelve solo elementos cuyo INICIO esté en las páginas núcleo. Para respuestas usa evidenceText como cita literal y candidateAnswer solo si figura inequívocamente. No infieras OMR, sombreado ni negrita sin evidencia estructural. Para cada elemento indica páginas reales y confianza. Devuelve únicamente JSON conforme al esquema.`;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function path(ownerId: string, importId: string, suffix: string): string {
  return `${ROOT}/${ownerId}/${importId}/interpretation/${suffix}`;
}

function blockPath(ownerId: string, importId: string, fingerprint: string, ref: OcrInterpretationBlockRef): string {
  return path(ownerId, importId, `blocks/${fingerprint}/${ref.fileId}-${String(ref.corePages[0]).padStart(5, "0")}.json`);
}

async function readJson<T>(pathname: string): Promise<T | null> {
  const result = await get(pathname, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  try { return JSON.parse(await new Response(result.stream).text()) as T; } catch { return null; }
}

async function writeJson(pathname: string, value: unknown, allowOverwrite = true): Promise<void> {
  await put(pathname, JSON.stringify(value), {
    access: "private", addRandomSuffix: false, allowOverwrite,
    cacheControlMaxAge: 60, contentType: "application/json",
  });
}

function emptyCounts(): OcrInterpretationCounts {
  return { ordinaryQuestions: 0, reserveQuestions: 0, completeOptions: 0, incompleteQuestions: 0, answerCandidates: 0, annulmentCandidates: 0, doubtfulElements: 0 };
}

export function interpretationHookToken(ownerId: string, importId: string, fingerprint: string, attempt = 1): string {
  const identity = `${ownerId}\n${importId}\n${fingerprint}`;
  return `ocr04:${hash(attempt === 1 ? identity : `${identity}\n${attempt}`)}`;
}

export function toInterpretationView(status: OcrInterpretationStatus): OcrInterpretationView {
  const { ownerId: _ownerId, runId: _runId, fingerprint: _fingerprint, model: _model, geminiCalls: _geminiCalls, ...view } = status;
  return view;
}

export async function readInterpretationStatus(ownerId: string, importId: string): Promise<OcrInterpretationStatus | null> {
  const result = await readJson<OcrInterpretationStatus>(path(ownerId, importId, "status.json"));
  return result?.ownerId === ownerId && result.importId === importId ? result : null;
}

export async function readInterpretationResult(ownerId: string, importId: string): Promise<OcrInterpretationResult | null> {
  const status = await readInterpretationStatus(ownerId, importId);
  if (!status || (status.state !== "completado" && status.state !== "revision")) return null;
  const result = await readJson<OcrInterpretationResult>(path(ownerId, importId, `results/${status.fingerprint}.json`));
  return result?.fingerprint === status.fingerprint && result.importId === importId ? result : null;
}

export async function buildInterpretationPlan(ownerId: string, manifest: OcrImportManifest, model: string): Promise<{ fingerprint: string; refs: OcrInterpretationBlockRef[] }> {
  const digest = createHash("sha256");
  const refs: OcrInterpretationBlockRef[] = [];
  const extraction = await readExtractionStatus(ownerId, manifest.id);
  for (const file of [...manifest.files].sort((a, b) => a.order - b.order)) {
    const progress = extraction?.files.find((item) => item.fileId === file.id);
    if (!progress?.totalPages || progress.state !== "completado") throw new HTTPError("La extracción todavía no está completa", { status: 409 });
    const lengths: number[] = [];
    digest.update(`${file.id}\n${file.originalName}\n${file.type}\n${file.order}\n`);
    for (let n = 1; n <= progress.totalPages; n += 1) {
      const page = await readPageExtraction(ownerId, manifest.id, file.id, n);
      if (!page?.quality.valid) throw new HTTPError("Falta una página extraída", { status: 409 });
      digest.update(JSON.stringify(page));
      lengths.push(page.text.length);
    }
    let first = 1;
    while (first <= lengths.length) {
      let end = first;
      while (end < lengths.length && end - first + 1 < MAX_CORE_PAGES) {
        end += 1;
      }
      const corePages = Array.from({ length: end - first + 1 }, (_, index) => first + index);
      const contextPages = Array.from({ length: Math.min(lengths.length, end + 1) - Math.max(1, first - 1) + 1 }, (_, index) => Math.max(1, first - 1) + index);
      refs.push({ fileId: file.id, originalName: file.originalName, manualType: file.type, fileOrder: file.order, corePages, contextPages });
      first = end + 1;
    }
  }
  const fingerprint = hash(`${digest.digest("hex")}\n${model}\n${PROMPT}\n${OCR_INTERPRETATION_PROMPT_VERSION}\n${OCR_INTERPRETATION_SCHEMA_VERSION}\n${JSON.stringify(OCR_INTERPRETATION_JSON_SCHEMA)}`);
  return { fingerprint, refs };
}

export async function createInterpretationStatus(ownerId: string, importId: string, fingerprint: string, model: string, totalBlocks: number): Promise<{ status: OcrInterpretationStatus; created: boolean }> {
  const existing = await readInterpretationStatus(ownerId, importId);
  if (existing?.fingerprint === fingerprint && existing.state !== "error") return { status: existing, created: false };
  if (existing && (existing.state === "pendiente" || existing.state === "procesando")) throw new HTTPError("Ya hay una interpretación en curso", { status: 409 });
  const now = new Date().toISOString();
  const status: OcrInterpretationStatus = {
    importId, ownerId, runId: null, attempt: existing?.fingerprint === fingerprint ? (existing.attempt ?? 1) + 1 : 1,
    fingerprint, model, state: "pendiente", stage: "en_cola",
    totalBlocks, processedBlocks: existing?.fingerprint === fingerprint ? existing.processedBlocks : 0,
    geminiCalls: existing?.fingerprint === fingerprint ? existing.geminiCalls : 0, counts: emptyCounts(),
    createdAt: now, updatedAt: now, completedAt: null, error: null,
  };
  try {
    await writeJson(path(ownerId, importId, "status.json"), status, Boolean(existing));
    return { status, created: true };
  } catch {
    const raced = await readInterpretationStatus(ownerId, importId);
    if (raced?.fingerprint === fingerprint && raced.state !== "error") return { status: raced, created: false };
    throw new HTTPError("No se pudo preparar la interpretación", { status: 503 });
  }
}

export async function deleteInterpretationStatus(ownerId: string, importId: string): Promise<void> {
  await del(path(ownerId, importId, "status.json")).catch(() => undefined);
}

async function updateStatus(ownerId: string, importId: string, updater: (status: OcrInterpretationStatus) => OcrInterpretationStatus): Promise<OcrInterpretationStatus> {
  const status = await readInterpretationStatus(ownerId, importId);
  if (!status) throw new Error("interpretation_status_not_found");
  const updated = { ...updater(status), updatedAt: new Date().toISOString() };
  await writeJson(path(ownerId, importId, "status.json"), updated);
  return updated;
}

export async function attachInterpretationRun(ownerId: string, importId: string, runId: string): Promise<OcrInterpretationStatus> {
  return updateStatus(ownerId, importId, (status) => ({ ...status, runId }));
}

export async function setInterpretationStage(ownerId: string, importId: string, stage: string): Promise<void> {
  await updateStatus(ownerId, importId, (status) => ({ ...status, state: "procesando", stage }));
}

export async function markInterpretationBlock(ownerId: string, importId: string, index: number): Promise<void> {
  await updateStatus(ownerId, importId, (status) => ({ ...status, processedBlocks: Math.max(status.processedBlocks, index + 1), stage: "interpretando_paginas" }));
}

async function recordGeminiCall(ownerId: string, importId: string): Promise<void> {
  await updateStatus(ownerId, importId, (status) => ({ ...status, geminiCalls: status.geminiCalls + 1 }));
}

function supported(value: string, source: string): boolean {
  return Boolean(groundedSpan(value, source));
}

function uniq<T>(values: T[]): T[] { return [...new Set(values)]; }

function manualMismatch(manual: string, classification: string): boolean {
  return (manual === "preguntas" && (classification === "respuestas" || classification === "mixto"))
    || (manual === "respuestas" && (classification === "preguntas" || classification === "mixto"))
    || (manual === "anexo" && (classification === "preguntas" || classification === "respuestas" || classification === "mixto"));
}

export function anchorInterpretation(output: ModelInterpretation, ref: OcrInterpretationBlockRef, pages: OcrPageExtraction[]): OcrSemanticBlock {
  const byNumber = new Map(pages.map((page) => [page.pageNumber, page]));
  const contextSource = pages.map((page) => page.text).join("\n");
  const questions: OcrQuestionCandidate[] = [];
  const answers: OcrAnswerCandidate[] = [];
  const issues = output.issues.slice(0, 30);
  if (manualMismatch(ref.manualType, output.classification)) issues.push("tipo_indicado_incompatible");
  for (const item of output.questions) {
    const validPages = uniq(item.pages.filter((page) => byNumber.has(page))).sort((a, b) => a - b);
    if (!validPages.length || !ref.corePages.includes(validPages[0]!)) continue;
    const source = validPages.map((page) => byNumber.get(page)!.text).join("\n");
    const questionIssues: OcrQuestionCandidate["issues"] = [...item.issues];
    if (validPages.length !== item.pages.length) questionIssues.push("contenido_no_verificado");
    const groundedStatement = groundedSpan(item.statement, source)?.text ?? "";
    const groundedOptions = item.options.flatMap((option) => {
      const span = groundedSpan(option.text, source);
      return span && supported(option.letter, source) ? [{ letter: option.letter.toUpperCase(), text: span.text }] : [];
    });
    const repeatedLetters = new Set(groundedOptions.map((option) => option.letter)).size !== groundedOptions.length;
    const recovered = !groundedStatement || groundedOptions.length < item.options.length || groundedOptions.length < 4 || repeatedLetters
      ? recoverQuestionFromSource(pages, validPages[0]!, item.printedNumber) : null;
    const statement = recovered && (!groundedStatement || groundedSpan(item.statement, recovered.statement))
      ? recovered.statement : groundedStatement;
    if (!statement) questionIssues.push("texto_incompleto", "contenido_no_verificado");
    const subparts = item.subparts.flatMap((part) => {
      const span = groundedSpan(part.text, source);
      return span && supported(part.label, source) ? [{ label: part.label, text: span.text }] : [];
    });
    if (subparts.length !== item.subparts.length) questionIssues.push("contenido_no_verificado");
    const options = recovered && recovered.options.length >= groundedOptions.length
      && (groundedOptions.length < 4 || repeatedLetters) ? recovered.options : groundedOptions;
    if (options.length < 4 || new Set(options.map((option) => option.letter)).size !== options.length
      || (options === groundedOptions && options.length !== item.options.length)) questionIssues.push("opciones_incompletas");
    const tables = item.tables.filter((table) => supported(table.text, source)).map((table) => ({
      text: groundedSpan(table.text, source)!.text,
      rows: table.rows.map((row) => row.filter((cell) => supported(cell, source))).filter((row) => row.length),
    }));
    if (tables.length !== item.tables.length || tables.some((table, index) => table.rows.flat().length !== item.tables[index]?.rows.flat().length)) questionIssues.push("contenido_no_verificado");
    const printedNumber = item.printedNumber && supported(item.printedNumber, source) ? item.printedNumber : null;
    if (item.printedNumber && !printedNumber) questionIssues.push("numeracion_dudosa");
    if (recovered && (!groundedStatement || options === recovered.options)) {
      for (const page of recovered.pages) if (!validPages.includes(page)) validPages.push(page);
      validPages.sort((a, b) => a - b);
    }
    if (validPages.length > 1) questionIssues.push("salto_de_pagina");
    const section = item.section === "reserva" && !/reserva/i.test(contextSource) ? "desconocida" : item.section;
    if (section !== item.section) questionIssues.push("numeracion_dudosa");
    questions.push({
      id: hash(`${ref.fileId}\n${validPages.join(",")}\n${printedNumber}\n${statement}\n${section}`).slice(0, 24),
      printedNumber, section, statement, subparts, options, tables,
      fileId: ref.fileId, originalName: ref.originalName, pages: validPages,
      confidence: item.confidence, issues: uniq(questionIssues.filter((issue) =>
        !((issue === "texto_incompleto" && !groundedStatement && Boolean(recovered?.statement))
          || (issue === "opciones_incompletas" && options === recovered?.options && options.length >= 4)))),
    });
  }
  for (const item of output.answers) {
    if (!ref.corePages.includes(item.page)) continue;
    const source = byNumber.get(item.page)?.text ?? "";
    const answerIssues = [...item.issues];
    const evidenceText = supported(item.evidenceText, source) ? item.evidenceText : "";
    let candidateAnswer = item.candidateAnswer && evidenceText && supported(item.candidateAnswer, evidenceText) ? item.candidateAnswer : null;
    if (item.candidateAnswer && !candidateAnswer) answerIssues.push("respuesta_no_verificada");
    let state = item.state;
    if (!evidenceText || (state === "anulada" && !/anulad|invalid/i.test(evidenceText))) {
      state = "ambigua";
      candidateAnswer = null;
      answerIssues.push("evidencia_no_verificada");
    }
    if (state === "respondida" && !candidateAnswer) state = "ambigua";
    const unverifiedFormat = ["negrita", "sombreado", "casilla", "omr"].includes(item.format);
    if (unverifiedFormat) answerIssues.push("formato_no_verificado");
    const printedNumber = item.printedNumber && supported(item.printedNumber, source) ? item.printedNumber : null;
    if (item.printedNumber && !printedNumber) answerIssues.push("numeracion_dudosa");
    const section = item.section === "reserva" && !/reserva/i.test(contextSource) ? "desconocida" : item.section;
    if (section !== item.section) answerIssues.push("seccion_dudosa");
    answers.push({
      id: hash(`${ref.fileId}\n${item.page}\n${printedNumber}\n${evidenceText}\n${candidateAnswer}`).slice(0, 24),
      printedNumber, section, candidateAnswer, state, format: unverifiedFormat ? "otro" : item.format,
      evidenceText, fileId: ref.fileId, originalName: ref.originalName, page: item.page,
      confidence: item.confidence, issues: uniq(answerIssues),
    });
  }
  if (output.questions.length > questions.length || output.answers.length > answers.length) issues.push("elementos_fuera_de_paginas_nucleo");
  const classification = questions.length && answers.length ? "mixto" : output.classification;
  if (classification !== output.classification) issues.push("clasificacion_incompatible_con_contenido");
  return { fileId: ref.fileId, originalName: ref.originalName, corePages: ref.corePages, classification, manualType: ref.manualType, issues: uniq(issues), questions, answers };
}

function responseText(payload: unknown): string {
  const candidate = (payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> })?.candidates?.[0];
  return candidate?.content?.parts?.map((part) => typeof part.text === "string" ? part.text : "").join("") ?? "";
}

export function isTransientGeminiError(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  return status === 408 || status === 429 || (typeof status === "number" && status >= 500) || error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError");
}

export async function processInterpretationBlock(ownerId: string, importId: string, fingerprint: string, ref: OcrInterpretationBlockRef): Promise<void> {
  const pathname = blockPath(ownerId, importId, fingerprint, ref);
  if (await readJson<OcrSemanticBlock>(pathname)) return;
  const pages: OcrPageExtraction[] = [];
  for (const pageNumber of ref.contextPages) {
    const page = await readPageExtraction(ownerId, importId, ref.fileId, pageNumber);
    if (!page) throw new Error("missing_extraction_page");
    pages.push(page);
  }
  const input = pages.map((page) => ({
    fileId: page.fileId, originalName: page.originalName, pageNumber: page.pageNumber,
    method: page.method, text: page.text,
    lines: ref.corePages.includes(page.pageNumber) ? page.lines.map((line) => ({
      text: line.text, order: line.order, box: line.boundingBoxes[0] ?? null,
    })) : [],
  }));
  const source = JSON.stringify({ file: ref.originalName, manualType: ref.manualType, corePages: ref.corePages, pages: input });
  const request = (prompt: string) => ({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", responseJsonSchema: OCR_INTERPRETATION_JSON_SCHEMA, maxOutputTokens: 8192, temperature: 0 },
  });
  await recordGeminiCall(ownerId, importId);
  const first = responseText(await callGemini(request(`${PROMPT}\n\nDATOS OCR-03:\n${source}`)));
  const parsed = await parseWithSingleRepair(first, async () => {
    await recordGeminiCall(ownerId, importId);
    return responseText(await callGemini(request(`${PROMPT}\n\nEl JSON anterior es inválido para el esquema. Corrígelo una sola vez sin añadir información.\nJSON ANTERIOR:\n${first}\n\nDATOS OCR-03:\n${source}`)));
  });
  await writeJson(pathname, anchorInterpretation(parsed, ref, pages));
}

export async function finalizeInterpretation(ownerId: string, importId: string, fingerprint: string, model: string, refs: OcrInterpretationBlockRef[]): Promise<OcrInterpretationStatus> {
  const blocks: OcrSemanticBlock[] = [];
  for (const ref of refs) {
    const block = await readJson<OcrSemanticBlock>(blockPath(ownerId, importId, fingerprint, ref));
    if (!block) throw new Error("missing_interpretation_block");
    blocks.push(block);
  }
  const questionIds = new Set<string>();
  const answerIds = new Set<string>();
  const questions = blocks.flatMap((block) => block.questions).filter((question) => {
    if (questionIds.has(question.id)) return false;
    questionIds.add(question.id);
    return true;
  });
  const answers = blocks.flatMap((block) => block.answers).filter((answer) => {
    if (answerIds.has(answer.id)) return false;
    answerIds.add(answer.id);
    return true;
  });
  const counts: OcrInterpretationCounts = {
    ordinaryQuestions: questions.filter((item) => item.section === "ordinaria").length,
    reserveQuestions: questions.filter((item) => item.section === "reserva").length,
    completeOptions: questions.filter((item) => item.options.length >= 4 && !item.issues.includes("opciones_incompletas")).length,
    incompleteQuestions: questions.filter((item) => !item.statement || item.options.length < 4 || item.issues.includes("opciones_incompletas") || item.issues.includes("texto_incompleto")).length,
    answerCandidates: answers.length,
    annulmentCandidates: answers.filter((item) => item.state === "anulada").length,
    doubtfulElements: questions.filter((item) => item.issues.length > 0 || item.section === "desconocida").length
      + answers.filter((item) => item.issues.length > 0 || item.state === "ambigua" || item.state === "sin_determinar").length
      + blocks.filter((item) => item.issues.length > 0 || item.classification === "desconocido").length,
  };
  const result: OcrInterpretationResult = { importId, fingerprint, schemaVersion: OCR_INTERPRETATION_SCHEMA_VERSION, model, blocks, questions, answers, createdAt: new Date().toISOString() };
  await writeJson(path(ownerId, importId, `results/${fingerprint}.json`), result);
  const review = counts.doubtfulElements > 0 || counts.incompleteQuestions > 0
    || (questions.length === 0 && answers.length === 0 && blocks.some((block) => block.manualType !== "anexo"));
  return updateStatus(ownerId, importId, (status) => ({
    ...status, state: review ? "revision" : "completado", stage: review ? "requiere_revision" : "interpretacion_completada",
    processedBlocks: refs.length, counts, completedAt: new Date().toISOString(), error: null,
  }));
}

export async function markInterpretationFailure(ownerId: string, importId: string, message = "La interpretación no pudo completarse. Puedes reintentarla."): Promise<void> {
  await updateStatus(ownerId, importId, (status) => ["completado", "revision"].includes(status.state)
    ? status : { ...status, state: "error", stage: "fallo_interpretacion", completedAt: new Date().toISOString(), error: message }).catch(() => undefined);
}
