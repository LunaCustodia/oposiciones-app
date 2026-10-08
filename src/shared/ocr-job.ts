export const OCR_JOB_STATES = [
  "pendiente",
  "procesando",
  "revisión",
  "completado",
  "error",
] as const;

export type OcrJobState = (typeof OCR_JOB_STATES)[number];

export interface OcrJobContract {
  id: string;
  ownerId: string;
  privateDocumentRefs: string[];
  state: OcrJobState;
  stage: string;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}

export interface ConnectionProbeResult {
  gemini: "real" | "pending_configuration";
  documentAi: "real" | "pending_configuration";
}

export interface TechnicalJobResult {
  mechanism: "vercel_workflow";
  completedAt: string;
  connections: ConnectionProbeResult;
}

export interface TechnicalWorkflowResult {
  kind: "completed" | "duplicate";
  job: OcrJobContract;
  result?: TechnicalJobResult;
  ownerRunId?: string;
}
