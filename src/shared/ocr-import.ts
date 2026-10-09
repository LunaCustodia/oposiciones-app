export const OCR_IMPORT_FILE_TYPES = [
  "auto",
  "preguntas",
  "respuestas",
  "mixto",
  "anexo",
] as const;

export type OcrImportFileType = (typeof OCR_IMPORT_FILE_TYPES)[number];
export type OcrImportState = "subiendo" | "lista" | "error";

export interface OcrImportMetadata {
  titulo: string | null;
  año: number | null;
  organismo: string | null;
  categoria: string | null;
}

export interface OcrImportFile {
  id: string;
  originalName: string;
  size: number;
  mimeType: "application/pdf";
  type: OcrImportFileType;
  order: number;
  pathname: string;
}

export interface OcrImportManifest {
  id: string;
  ownerId: string;
  metadata: OcrImportMetadata;
  files: OcrImportFile[];
  state: OcrImportState;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}

export interface OcrImportView {
  id: string;
  metadata: OcrImportMetadata;
  files: Array<Pick<OcrImportFile, "id" | "originalName" | "size" | "type" | "order">>;
  state: OcrImportState;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}

