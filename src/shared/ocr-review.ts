import type { OcrAnswerEvidence } from "./ocr-binding.js";
import type { OcrQuestionCandidate } from "./ocr-interpretation.js";

export type ReviewSection = "ordinaria" | "reserva" | "desconocida";
export type ReviewResolution = "respuesta" | "anulada" | "pendiente";
export type ReviewDestination = "oficiales" | "otros";

export interface ReviewQuestionValue {
  number: string;
  section: ReviewSection;
  statement: string;
  subparts: Array<{ label: string; text: string }>;
  options: Array<{ letter: string; text: string }>;
  tables: Array<{ text: string; rows: string[][] }>;
  answer: string | null;
  resolution: ReviewResolution;
}

export interface ReviewCorrection {
  value: ReviewQuestionValue;
  correctedAt: string;
  evidenceId: string | null;
}

export interface ReviewOrphanDecision {
  action: "associate" | "discard";
  questionId: string | null;
  decidedAt: string;
  evidenceId: string;
}

export interface ReviewDraft {
  importId: string;
  ownerId: string;
  fingerprint: string;
  destination: ReviewDestination;
  corrections: Record<string, ReviewCorrection>;
  orphans: Record<string, ReviewOrphanDecision>;
  imported: { examId: string; destination: ReviewDestination } | null;
  updatedAt: string;
}

export interface ReviewQuestion {
  id: string;
  detected: ReviewQuestionValue;
  corrected: ReviewCorrection | null;
  value: ReviewQuestionValue;
  source: OcrQuestionCandidate;
  evidence: OcrAnswerEvidence[];
  initialState: string;
  issues: string[];
}

export interface ReviewView {
  importId: string;
  metadata: { titulo: string | null; año: number | null; organismo: string | null; categoria: string | null };
  destination: ReviewDestination;
  questions: ReviewQuestion[];
  orphans: Array<{ evidence: OcrAnswerEvidence; decision: ReviewOrphanDecision | null }>;
  blockers: Array<{ questionId: string | null; message: string }>;
  updatedAt: string | null;
  imported: { examId: string; destination: ReviewDestination } | null;
}
