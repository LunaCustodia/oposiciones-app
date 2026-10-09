export const OCR_INTERPRETATION_SCHEMA_VERSION = "ocr04-v1";
export const OCR_INTERPRETATION_PROMPT_VERSION = "semantic-2026-10-09-v3";

export type OcrInterpretationState = "pendiente" | "procesando" | "completado" | "revision" | "error";
export type OcrSemanticSection = "ordinaria" | "reserva" | "desconocida";
export type OcrSemanticClassification = "preguntas" | "respuestas" | "mixto" | "anexo" | "desconocido";
export type OcrQuestionIssue = "numeracion_dudosa" | "texto_incompleto" | "opciones_incompletas" | "salto_de_pagina" | "posible_duplicado" | "contenido_no_verificado";

export interface OcrQuestionCandidate {
  id: string;
  printedNumber: string | null;
  section: OcrSemanticSection;
  statement: string;
  subparts: Array<{ label: string; text: string }>;
  options: Array<{ letter: string; text: string }>;
  tables: Array<{ text: string; rows: string[][] }>;
  fileId: string;
  originalName: string;
  pages: number[];
  confidence: number;
  issues: OcrQuestionIssue[];
}

export interface OcrAnswerCandidate {
  id: string;
  printedNumber: string | null;
  section: OcrSemanticSection;
  candidateAnswer: string | null;
  state: "respondida" | "anulada" | "ambigua" | "sin_determinar";
  format: "tabla" | "listado" | "negrita" | "sombreado" | "casilla" | "omr" | "otro";
  evidenceText: string;
  fileId: string;
  originalName: string;
  page: number;
  confidence: number;
  issues: string[];
}

export interface OcrSemanticBlock {
  fileId: string;
  originalName: string;
  corePages: number[];
  classification: OcrSemanticClassification;
  manualType: string;
  issues: string[];
  questions: OcrQuestionCandidate[];
  answers: OcrAnswerCandidate[];
}

export interface OcrInterpretationResult {
  importId: string;
  fingerprint: string;
  schemaVersion: string;
  model: string;
  blocks: OcrSemanticBlock[];
  questions: OcrQuestionCandidate[];
  answers: OcrAnswerCandidate[];
  createdAt: string;
}

export interface OcrInterpretationCounts {
  ordinaryQuestions: number;
  reserveQuestions: number;
  completeOptions: number;
  incompleteQuestions: number;
  answerCandidates: number;
  annulmentCandidates: number;
  doubtfulElements: number;
}

export interface OcrInterpretationStatus {
  importId: string;
  ownerId: string;
  runId: string | null;
  attempt?: number;
  fingerprint: string;
  model: string;
  state: OcrInterpretationState;
  stage: string;
  totalBlocks: number;
  processedBlocks: number;
  geminiCalls: number;
  counts: OcrInterpretationCounts;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
}

export type OcrInterpretationView = Omit<OcrInterpretationStatus, "ownerId" | "runId" | "fingerprint" | "model" | "geminiCalls">;

export interface OcrInterpretationBlockRef {
  fileId: string;
  originalName: string;
  manualType: string;
  fileOrder: number;
  corePages: number[];
  contextPages: number[];
}

export interface OcrInterpretationWorkflowResult {
  kind: "completed" | "duplicate";
  importId: string;
  state?: OcrInterpretationState;
  ownerRunId?: string;
}
