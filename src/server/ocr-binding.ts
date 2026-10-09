import { createHash } from "node:crypto";
import { del, get, put } from "@vercel/blob";
import { HTTPError } from "nitro";
import type { OcrImportManifest } from "../shared/ocr-import.js";
import type { OcrPageExtraction } from "../shared/ocr-extraction.js";
import { OCR_BINDING_VERSION, type OcrAnswerEvidence, type OcrBindingResult, type OcrBindingStatus, type OcrBindingView } from "../shared/ocr-binding.js";
import { callGemini } from "./connections.js";
import { readPageExtraction, readPrivateImportPdf, readExtractionStatus } from "./ocr-extractions.js";
import { readInterpretationResult } from "./ocr-interpretation.js";
import { linkAnswers } from "./ocr-binding-link.js";
import { fromSemanticCandidates, pageLooksLikeTemplate, parseTextualAnswers } from "./ocr-binding-text.js";
import { detectBoldRows, inferVisualRows, renderVisualPage, sampleVisualRow, visualEvidence } from "./ocr-binding-visual.js";

export interface BindingPageRef { fileId: string; pageNumber: number; }
const root = "ocr02/imports";
const zeroCounts = () => ({ linked: 0, annulled: 0, unanswered: 0, ambiguous: 0, conflicts: 0, orphans: 0 });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const path = (ownerId: string, importId: string, suffix: string) => `${root}/${ownerId}/${importId}/binding/${suffix}`;
const pagePath = (ownerId: string, importId: string, fingerprint: string, ref: BindingPageRef) => path(ownerId, importId, `pages/${fingerprint}/${ref.fileId}-${String(ref.pageNumber).padStart(5, "0")}.json`);

async function readJson<T>(pathname: string): Promise<T | null> {
  const blob = await get(pathname, { access: "private", useCache: false });
  if (!blob || blob.statusCode !== 200 || !blob.stream) return null;
  try { return JSON.parse(await new Response(blob.stream).text()) as T; } catch { return null; }
}
async function writeJson(pathname: string, value: unknown, overwrite = true): Promise<void> {
  await put(pathname, JSON.stringify(value), { access: "private", addRandomSuffix: false, allowOverwrite: overwrite,
    cacheControlMaxAge: 60, contentType: "application/json" });
}
export function bindingHookToken(ownerId: string, importId: string, fingerprint: string): string {
  return `ocr05:${hash(`${ownerId}\n${importId}\n${fingerprint}`)}`;
}
export function toBindingView(status: OcrBindingStatus): OcrBindingView {
  const { ownerId: _ownerId, runId: _runId, fingerprint: _fingerprint, geminiVisualCalls: _calls, ...view } = status;
  return view;
}
export async function readBindingStatus(ownerId: string, importId: string): Promise<OcrBindingStatus | null> {
  const result = await readJson<OcrBindingStatus>(path(ownerId, importId, "status.json"));
  return result?.ownerId === ownerId && result.importId === importId ? result : null;
}
export async function readBindingResult(ownerId: string, importId: string): Promise<OcrBindingResult | null> {
  const status = await readBindingStatus(ownerId, importId);
  if (!status || !["completado", "revision"].includes(status.state)) return null;
  const result = await readJson<OcrBindingResult>(path(ownerId, importId, `results/${status.fingerprint}.json`));
  return result?.fingerprint === status.fingerprint && result.importId === importId ? result : null;
}
export async function buildBindingPlan(ownerId: string, manifest: OcrImportManifest): Promise<{ fingerprint: string; refs: BindingPageRef[] }> {
  const interpretation = await readInterpretationResult(ownerId, manifest.id);
  const extraction = await readExtractionStatus(ownerId, manifest.id);
  if (!interpretation || extraction?.state !== "completado") throw new HTTPError("La interpretación OCR-04 debe estar terminada", { status: 409 });
  const refs: BindingPageRef[] = [];
  const digest = createHash("sha256").update(`${OCR_BINDING_VERSION}\n${interpretation.fingerprint}\n`);
  for (const file of [...manifest.files].sort((a, b) => a.order - b.order)) {
    const progress = extraction.files.find((item) => item.fileId === file.id);
    if (!progress || progress.state !== "completado" || !progress.totalPages) throw new HTTPError("Falta extracción de un PDF", { status: 409 });
    digest.update(`${file.id}:${file.type}:${file.order}\n`);
    for (let pageNumber = 1; pageNumber <= progress.totalPages; pageNumber += 1) {
      const page = await readPageExtraction(ownerId, manifest.id, file.id, pageNumber);
      if (!page?.quality.valid) throw new HTTPError("Falta extracción de una página", { status: 409 });
      digest.update(`${page.sourceSha256}:${page.pageNumber}\n`);
      const classified = interpretation.blocks.some((block) => block.fileId === file.id && block.corePages.includes(pageNumber)
        && ["respuestas", "mixto"].includes(block.classification));
      const candidate = interpretation.answers.some((answer) => answer.fileId === file.id && answer.page === pageNumber);
      if (pageLooksLikeTemplate(page, file.type === "respuestas" || file.type === "mixto", classified || candidate)) refs.push({ fileId: file.id, pageNumber });
    }
  }
  return { fingerprint: digest.digest("hex"), refs };
}
export async function createBindingStatus(ownerId: string, importId: string, fingerprint: string, totalPages: number): Promise<{ status: OcrBindingStatus; created: boolean }> {
  const existing = await readBindingStatus(ownerId, importId);
  if (existing?.fingerprint === fingerprint) return { status: existing, created: false };
  if (existing && ["pendiente", "procesando"].includes(existing.state)) throw new HTTPError("Ya hay una vinculación en curso", { status: 409 });
  const now = new Date().toISOString();
  const status: OcrBindingStatus = { importId, ownerId, runId: null, fingerprint, state: "pendiente", stage: "en_cola",
    totalPages, processedPages: 0, geminiVisualCalls: 0, counts: zeroCounts(), createdAt: now, updatedAt: now, completedAt: null, error: null };
  try { await writeJson(path(ownerId, importId, "status.json"), status, Boolean(existing)); return { status, created: true }; }
  catch {
    const raced = await readBindingStatus(ownerId, importId);
    if (raced?.fingerprint === fingerprint) return { status: raced, created: false };
    throw new HTTPError("No se pudo preparar la vinculación", { status: 503 });
  }
}
export async function deleteBindingStatus(ownerId: string, importId: string): Promise<void> {
  await del(path(ownerId, importId, "status.json")).catch(() => undefined);
}
async function update(ownerId: string, importId: string, patch: (current: OcrBindingStatus) => OcrBindingStatus): Promise<OcrBindingStatus> {
  const current = await readBindingStatus(ownerId, importId);
  if (!current) throw new Error("binding_status_missing");
  const status = { ...patch(current), updatedAt: new Date().toISOString() };
  await writeJson(path(ownerId, importId, "status.json"), status);
  return status;
}
export const attachBindingRun = (ownerId: string, importId: string, runId: string) => update(ownerId, importId, (s) => ({ ...s, runId }));
export const setBindingStage = (ownerId: string, importId: string, stage: string) => update(ownerId, importId, (s) => ({ ...s, state: "procesando", stage }));
export const markBindingPage = (ownerId: string, importId: string, index: number) => update(ownerId, importId, (s) => ({ ...s, processedPages: Math.max(s.processedPages, index + 1) }));
export const markBindingFailure = (ownerId: string, importId: string) => update(ownerId, importId, (s) => ({ ...s, state: "error", stage: "fallo_vinculacion", completedAt: new Date().toISOString(), error: "No se pudo completar la vinculación." })).catch(() => undefined);

async function geminiVisualProposal(ownerId: string, importId: string, image: Buffer): Promise<OcrAnswerEvidence[]> {
  await update(ownerId, importId, (s) => ({ ...s, geminiVisualCalls: s.geminiVisualCalls + 1 }));
  const response = await callGemini({ contents: [{ role: "user", parts: [
    { text: "Describe SOLO las filas de respuesta visibles de esta plantilla. Devuelve JSON con rows: array de {number: string, section: ordinaria|reserva|desconocida, answer: A|B|C|D|E|null, annulled: boolean}. No inventes filas o respuestas. La propuesta se tratará como dudosa hasta verificarla geométricamente." },
    { inlineData: { mimeType: "image/png", data: image.toString("base64") } },
  ] }], generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 2048 } });
  const text = (response as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return []; }
  const rows = (parsed as { rows?: unknown })?.rows;
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 200).flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const row = raw as Record<string, unknown>;
    if (typeof row.number !== "string" || !/^\d{1,3}$/u.test(row.number)) return [];
    const section = ["ordinaria", "reserva", "desconocida"].includes(String(row.section)) ? row.section as OcrAnswerEvidence["section"] : "desconocida";
    const answer = typeof row.answer === "string" && /^[A-E]$/u.test(row.answer) ? row.answer : null;
    return [{ id: hash(`${importId}:${index}:${row.number}:${section}`).slice(0, 24), printedNumber: row.number,
      section, answer, annulled: row.annulled === true, ambiguous: true, method: "gemini_visual" as const,
      fileId: "", originalName: "", page: 0, coordinates: null, imageId: null, confidence: 0.4,
      markScores: null, issues: ["propuesta_visual_no_verificada"] }];
  });
}

export async function processBindingPage(ownerId: string, importId: string, fingerprint: string, ref: BindingPageRef): Promise<void> {
  const pathname = pagePath(ownerId, importId, fingerprint, ref);
  if (await readJson<OcrAnswerEvidence[]>(pathname)) return;
  const page = await readPageExtraction(ownerId, importId, ref.fileId, ref.pageNumber);
  if (!page) throw new Error("binding_page_missing");
  const interpretation = await readInterpretationResult(ownerId, importId);
  if (!interpretation) throw new Error("binding_interpretation_missing");
  const semantic = interpretation.answers.filter((candidate) => candidate.fileId === ref.fileId && candidate.page === ref.pageNumber);
  const textual = parseTextualAnswers(page, "desconocida");
  const evidence: OcrAnswerEvidence[] = [...textual];
  const visualCue = /\b(?:omr|casillas?|c[ií]rculos?|sombread[oa]s?)\b/iu.test(page.text)
    || semantic.some((candidate) => ["omr", "casilla", "sombreado"].includes(candidate.format));
  // Toda página de plantilla seleccionada exige inspección visual: el texto
  // directo no informa de marcas o letras resaltadas en el PDF.
  {
    const manifest = await readPrivateImportPdf(ownerId, importId, ref.fileId);
    const visual = await renderVisualPage(manifest.bytes, ref.pageNumber);
    const rows = inferVisualRows(page, visual.width, visual.height, visual.scale);
    for (const row of rows) {
      const sample = sampleVisualRow(visual.data, visual.width, visual.height, row);
      if (!sample.answers.length && !sample.weak) continue;
      const imageId = hash(`${fingerprint}:${ref.fileId}:${ref.pageNumber}:${row.section}:${row.number}:${row.y}`).slice(0, 24);
      await put(path(ownerId, importId, `evidence/${imageId}.png`), visual.crop(row.y, row.radius), {
        access: "private", addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60, contentType: "image/png" });
      evidence.push(visualEvidence(page, sample, imageId));
    }
    if (rows.length === 0) {
      for (const row of await detectBoldRows(manifest.bytes, ref.pageNumber, page)) {
        const imageId = hash(`${fingerprint}:${ref.fileId}:${ref.pageNumber}:bold:${row.section}:${row.number}`).slice(0, 24);
        await put(path(ownerId, importId, `evidence/${imageId}.png`), visual.crop(visual.height - row.y * visual.scale, 10), {
          access: "private", addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60, contentType: "image/png" });
      evidence.push({ id: imageId, printedNumber: row.number, section: row.section, answer: row.duplicate ? null : row.answer,
          annulled: false, ambiguous: false, method: "negrita", fileId: ref.fileId, originalName: page.originalName,
          page: ref.pageNumber, coordinates: { coordinateSystem: "pdf_points_bottom_left", x: row.x, y: row.y, width: row.width, height: row.height },
          imageId, confidence: 0.96, markScores: null, issues: row.duplicate ? ["doble_marca"] : [] });
      }
    }
    if (visualCue && textual.length === 0 && evidence.length === 0) {
      const imageId = hash(`${fingerprint}:${ref.fileId}:${ref.pageNumber}:visual`).slice(0, 24);
      const image = visual.crop(visual.height / 2, visual.height / 2);
      await put(path(ownerId, importId, `evidence/${imageId}.png`), image, {
        access: "private", addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60, contentType: "image/png" });
      const proposals = await geminiVisualProposal(ownerId, importId, image);
      evidence.push(...proposals.map((proposal) => ({ ...proposal, fileId: ref.fileId, originalName: page.originalName, page: ref.pageNumber, imageId })));
    }
  }
  evidence.push(...fromSemanticCandidates(semantic).filter((item) => !evidence.some((verified) =>
    verified.printedNumber === item.printedNumber && verified.answer === item.answer
      && verified.annulled === item.annulled && (verified.section === item.section || verified.section === "desconocida" || item.section === "desconocida"))));
  await writeJson(pathname, evidence);
}

export async function finalizeBinding(ownerId: string, importId: string, fingerprint: string, refs: BindingPageRef[]): Promise<OcrBindingStatus> {
  const interpretation = await readInterpretationResult(ownerId, importId);
  if (!interpretation) throw new Error("binding_interpretation_missing");
  const evidence: OcrAnswerEvidence[] = [];
  for (const ref of refs) {
    const page = await readJson<OcrAnswerEvidence[]>(pagePath(ownerId, importId, fingerprint, ref));
    if (!page) throw new Error("binding_result_page_missing");
    evidence.push(...page);
  }
  const linked = linkAnswers(interpretation.questions, evidence);
  const result: OcrBindingResult = { importId, fingerprint, version: OCR_BINDING_VERSION,
    bindings: linked.bindings, orphans: linked.orphans, counts: linked.counts, createdAt: new Date().toISOString() };
  await writeJson(path(ownerId, importId, `results/${fingerprint}.json`), result);
  const review = linked.counts.conflicts > 0 || linked.counts.ambiguous > 0 || linked.counts.orphans > 0
    || linked.counts.unanswered > 0 || (refs.length > 0 && evidence.length === 0);
  return update(ownerId, importId, (s) => ({ ...s, state: review ? "revision" : "completado", stage: review ? "requiere_revision" : "vinculacion_completada",
    processedPages: refs.length, counts: linked.counts, completedAt: new Date().toISOString(), error: null }));
}

export async function readBindingEvidence(ownerId: string, importId: string, imageId: string): Promise<ReadableStream<Uint8Array> | null> {
  if (!/^[a-f0-9]{24}$/u.test(imageId)) return null;
  const result = await readBindingResult(ownerId, importId);
  if (!result?.bindings.some((binding) => binding.sources.some((source) => source.imageId === imageId))
    && !result?.orphans.some((source) => source.imageId === imageId)) return null;
  const blob = await get(path(ownerId, importId, `evidence/${imageId}.png`), { access: "private", useCache: false });
  return blob?.statusCode === 200 ? blob.stream : null;
}
