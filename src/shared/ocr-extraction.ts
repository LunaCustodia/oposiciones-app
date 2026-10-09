export type OcrExtractionState =
  | "pendiente"
  | "procesando"
  | "completado"
  | "revision"
  | "error";

export type OcrExtractionMethod = "direct" | "document_ai";

export interface OcrPoint {
  x: number;
  y: number;
}

export interface OcrBoundingBox {
  coordinateSystem: "pdf_points_bottom_left" | "normalized_top_left" | "pixels_top_left";
  vertices: OcrPoint[];
}

export interface OcrLayoutElement {
  id: string;
  text: string;
  order: number;
  confidence: number | null;
  boundingBoxes: OcrBoundingBox[];
}

export interface OcrPageQuality {
  valid: boolean;
  score: number;
  visibleCharacters: number;
  wordCount: number;
  illegalCharacterRatio: number;
  singleCharacterTokenRatio: number;
  sourceOrderDiscontinuityRatio: number;
}

export interface OcrPageExtraction {
  importId: string;
  fileId: string;
  originalName: string;
  fileOrder: number;
  pageNumber: number;
  method: OcrExtractionMethod;
  text: string;
  blocks: OcrLayoutElement[];
  paragraphs: OcrLayoutElement[];
  lines: OcrLayoutElement[];
  tokens: OcrLayoutElement[];
  readingOrder: {
    blocks: string[];
    paragraphs: string[];
    lines: string[];
    tokens: string[];
  };
  quality: OcrPageQuality;
  documentAiReason: string | null;
  issues: string[];
  sourceSha256: string;
  extractedAt: string;
}

export interface OcrExtractionFileProgress {
  fileId: string;
  originalName: string;
  order: number;
  state: "pendiente" | "procesando" | "completado" | "revision" | "error";
  totalPages: number | null;
  processedPages: number;
  directPages: number;
  documentAiPages: number;
  errorPages: number[];
  currentPage: number | null;
}

export interface OcrExtractionStatus {
  importId: string;
  ownerId: string;
  runId: string | null;
  state: OcrExtractionState;
  stage: string;
  totalFiles: number;
  processedFiles: number;
  totalPages: number;
  processedPages: number;
  directPages: number;
  documentAiPages: number;
  documentAiCalls: number;
  errorPages: number;
  files: OcrExtractionFileProgress[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
}

export type OcrExtractionView = Omit<OcrExtractionStatus, "ownerId" | "runId">;

export interface OcrExtractionFileCache {
  importId: string;
  fileId: string;
  sha256: string;
  pageCount: number;
  state: "completado" | "revision";
  directPages: number;
  documentAiPages: number;
  errorPages: number[];
  completedAt: string;
}

export interface OcrFallbackPage {
  pageNumber: number;
  reason: string;
}

export interface OcrPreparedFile {
  fileId: string;
  sha256: string;
  pageCount: number;
  cached: boolean;
  fallbackPages: OcrFallbackPage[];
}

export interface OcrExtractionWorkflowResult {
  kind: "completed" | "duplicate";
  importId: string;
  state?: OcrExtractionState;
  ownerRunId?: string;
}
