import type { OcrSemanticSection } from "./ocr-interpretation.js";

export const OCR_BINDING_VERSION = "ocr05-v6";
export type OcrBindingState = "pendiente" | "procesando" | "completado" | "revision" | "error";
export type OcrBindingDisposition = "vinculada" | "anulada" | "sin_respuesta" | "ambigua" | "conflicto";
export type OcrEvidenceMethod = "textual" | "tabla" | "negrita" | "sombreado" | "casilla" | "circulo" | "omr" | "gemini_visual";

export interface OcrAnswerEvidence {
  id: string;
  printedNumber: string | null;
  section: OcrSemanticSection;
  answer: string | null;
  annulled: boolean;
  ambiguous: boolean;
  method: OcrEvidenceMethod;
  fileId: string;
  originalName: string;
  page: number;
  coordinates: { coordinateSystem: "pdf_points_bottom_left" | "normalized_top_left" | "pixels_top_left"; x: number; y: number; width: number; height: number } | null;
  imageId: string | null;
  confidence: number;
  markScores: Record<string, number> | null;
  issues: string[];
}

export interface OcrQuestionBinding {
  questionId: string;
  printedNumber: string | null;
  section: OcrSemanticSection;
  questionFileId: string;
  questionPages: number[];
  state: OcrBindingDisposition;
  answer: string | null;
  sources: OcrAnswerEvidence[];
  reason: string | null;
}

export interface OcrBindingCounts {
  questions: number;
  answerRows: number;
  associated: number;
  unequivocal: number;
  duplicateMarks: number;
  linked: number;
  annulled: number;
  unanswered: number;
  ambiguous: number;
  conflicts: number;
  orphans: number;
}

export interface OcrBindingIncidentRow {
  printedNumber: string;
  section: OcrSemanticSection;
  page: number;
  scores: Record<string, number>;
  issue: string;
}

export interface OcrBindingResult {
  importId: string;
  fingerprint: string;
  version: string;
  bindings: OcrQuestionBinding[];
  orphans: OcrAnswerEvidence[];
  counts: OcrBindingCounts;
  createdAt: string;
}

export interface OcrBindingStatus {
  importId: string;
  ownerId: string;
  runId: string | null;
  fingerprint: string;
  state: OcrBindingState;
  stage: string;
  totalPages: number;
  processedPages: number;
  geminiVisualCalls: number;
  counts: OcrBindingCounts;
  incidentRows: OcrBindingIncidentRow[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
}

export type OcrBindingView = Omit<OcrBindingStatus, "ownerId" | "runId" | "fingerprint" | "geminiVisualCalls">;
