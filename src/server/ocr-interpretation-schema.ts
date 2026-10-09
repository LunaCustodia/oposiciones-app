import { Ajv } from "ajv";

const text = { type: "string" } as const;
const nullableText = { type: ["string", "null"] } as const;
const section = { type: "string", enum: ["ordinaria", "reserva", "desconocida"] } as const;
const confidence = { type: "number", minimum: 0, maximum: 1 } as const;
const pages = { type: "array", items: { type: "integer", minimum: 1 } } as const;
const strings = { type: "array", items: text } as const;
const questionIssues = {
  type: "array",
  items: {
    type: "string",
    enum: ["numeracion_dudosa", "texto_incompleto", "opciones_incompletas", "salto_de_pagina", "posible_duplicado"],
  },
} as const;

export const OCR_INTERPRETATION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["classification", "issues", "questions", "answers"],
  properties: {
    classification: { type: "string", enum: ["preguntas", "respuestas", "mixto", "anexo", "desconocido"] },
    issues: strings,
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["printedNumber", "section", "statement", "subparts", "options", "tables", "pages", "confidence", "issues"],
        properties: {
          printedNumber: nullableText,
          section,
          statement: text,
          subparts: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "text"],
              properties: { label: text, text },
            },
          },
          options: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["letter", "text"],
              properties: { letter: text, text },
            },
          },
          tables: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["text", "rows"],
              properties: { text, rows: { type: "array", items: strings } },
            },
          },
          pages,
          confidence,
          issues: questionIssues,
        },
      },
    },
    answers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["printedNumber", "section", "candidateAnswer", "state", "format", "evidenceText", "page", "confidence", "issues"],
        properties: {
          printedNumber: nullableText,
          section,
          candidateAnswer: nullableText,
          state: { type: "string", enum: ["respondida", "anulada", "ambigua", "sin_determinar"] },
          format: { type: "string", enum: ["tabla", "listado", "negrita", "sombreado", "casilla", "omr", "otro"] },
          evidenceText: text,
          page: { type: "integer", minimum: 1 },
          confidence,
          issues: strings,
        },
      },
    },
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(OCR_INTERPRETATION_JSON_SCHEMA);

export interface ModelQuestion {
  printedNumber: string | null;
  section: "ordinaria" | "reserva" | "desconocida";
  statement: string;
  subparts: Array<{ label: string; text: string }>;
  options: Array<{ letter: string; text: string }>;
  tables: Array<{ text: string; rows: string[][] }>;
  pages: number[];
  confidence: number;
  issues: Array<"numeracion_dudosa" | "texto_incompleto" | "opciones_incompletas" | "salto_de_pagina" | "posible_duplicado">;
}

export interface ModelAnswer {
  printedNumber: string | null;
  section: ModelQuestion["section"];
  candidateAnswer: string | null;
  state: "respondida" | "anulada" | "ambigua" | "sin_determinar";
  format: "tabla" | "listado" | "negrita" | "sombreado" | "casilla" | "omr" | "otro";
  evidenceText: string;
  page: number;
  confidence: number;
  issues: string[];
}

export interface ModelInterpretation {
  classification: "preguntas" | "respuestas" | "mixto" | "anexo" | "desconocido";
  issues: string[];
  questions: ModelQuestion[];
  answers: ModelAnswer[];
}

export function parseModelInterpretation(raw: string): ModelInterpretation {
  const parsed: unknown = JSON.parse(raw);
  if (!validate(parsed)) throw new Error("invalid_interpretation_schema");
  return parsed as ModelInterpretation;
}

export async function parseWithSingleRepair(raw: string, repair: () => Promise<string>): Promise<ModelInterpretation> {
  try { return parseModelInterpretation(raw); } catch { return parseModelInterpretation(await repair()); }
}
