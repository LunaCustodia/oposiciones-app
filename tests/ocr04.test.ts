import { describe, expect, it } from "vitest";
import type { OcrPageExtraction } from "../src/shared/ocr-extraction.js";
import type { OcrInterpretationBlockRef } from "../src/shared/ocr-interpretation.js";
import { anchorInterpretation } from "../src/server/ocr-interpretation.js";
import { groundedSpan, recoverQuestionFromSource } from "../src/server/ocr-interpretation-grounding.js";
import { parseWithSingleRepair, type ModelInterpretation } from "../src/server/ocr-interpretation-schema.js";

const ref: OcrInterpretationBlockRef = {
  fileId: "file-1", originalName: "tecnico.pdf", manualType: "auto", fileOrder: 0,
  corePages: [1, 2, 3], contextPages: [1, 2, 3],
};

function page(pageNumber: number, text: string): OcrPageExtraction {
  return {
    importId: "import-1", fileId: ref.fileId, originalName: ref.originalName, fileOrder: 0,
    pageNumber, method: "direct", text, blocks: [], paragraphs: [], lines: [], tokens: [],
    readingOrder: { blocks: [], paragraphs: [], lines: [], tokens: [] },
    quality: { valid: true, score: 1, visibleCharacters: text.length, wordCount: text.split(/\s+/).length, illegalCharacterRatio: 0, singleCharacterTokenRatio: 0, sourceOrderDiscontinuityRatio: 0 },
    documentAiReason: null, issues: [], sourceSha256: "x", extractedAt: "2026-10-09T00:00:00Z",
  };
}

const sourcePages = [
  page(1, "1. ¿Cuál es la función de"),
  page(2, "los archivos? A. Conservar documentos B. Eliminar documentos C. Ordenar libros D. Archivar correos. 2. Según la tabla, indique el año. Año | Valor 2023 | 5"),
  page(3, "PREGUNTAS DE RESERVA 1. ¿Qué es un catálogo? A. Registro B. Edificio C. Calle D. Vehículo. Plantilla: 1 C, 2 B, 3 A. Pregunta 4 anulada. 5 A o B (ambigua)."),
];

const output: ModelInterpretation = {
  classification: "mixto", issues: [],
  questions: [
    { printedNumber: "1", section: "ordinaria", statement: "¿Cuál es la función de los archivos?", subparts: [], options: [
      { letter: "A", text: "Conservar documentos" }, { letter: "B", text: "Eliminar documentos" },
      { letter: "C", text: "Ordenar libros" }, { letter: "D", text: "Archivar correos" },
    ], tables: [], pages: [1, 2], confidence: 0.9, issues: ["salto_de_pagina"] },
    { printedNumber: "2", section: "ordinaria", statement: "Según la tabla, indique el año.", subparts: [], options: [], tables: [{ text: "Año | Valor 2023 | 5", rows: [["Año", "Valor"], ["2023", "5"]] }], pages: [2], confidence: 0.8, issues: ["opciones_incompletas"] },
    { printedNumber: "1", section: "reserva", statement: "¿Qué es un catálogo?", subparts: [], options: [
      { letter: "A", text: "Registro" }, { letter: "B", text: "Edificio" },
      { letter: "C", text: "Calle" }, { letter: "D", text: "Vehículo" },
    ], tables: [], pages: [3], confidence: 0.9, issues: [] },
  ],
  answers: [
    { printedNumber: "1", section: "desconocida", candidateAnswer: "C", state: "respondida", format: "listado", evidenceText: "1 C", page: 3, confidence: 0.9, issues: [] },
    { printedNumber: "4", section: "desconocida", candidateAnswer: null, state: "anulada", format: "listado", evidenceText: "Pregunta 4 anulada", page: 3, confidence: 0.9, issues: [] },
    { printedNumber: "5", section: "desconocida", candidateAnswer: null, state: "ambigua", format: "listado", evidenceText: "5 A o B (ambigua)", page: 3, confidence: 0.5, issues: ["respuesta_ambigua"] },
  ],
};

describe("OCR-04 semantic anchoring", () => {
  it("preserves ordinary, cross-page, reserve, table, answers and annulment", () => {
    const block = anchorInterpretation(output, ref, sourcePages);
    expect(block.questions).toHaveLength(3);
    expect(block.questions[0]?.pages).toEqual([1, 2]);
    expect(block.questions[0]?.options).toHaveLength(4);
    expect(block.questions[1]?.tables[0]?.rows).toEqual([["Año", "Valor"], ["2023", "5"]]);
    expect(block.questions[2]?.section).toBe("reserva");
    expect(block.questions[0]?.id).not.toBe(block.questions[2]?.id);
    expect(block.answers.map((answer) => answer.state)).toEqual(["respondida", "anulada", "ambigua"]);
    expect(block.answers[0]?.candidateAnswer).toBe("C");
  });

  it("removes unsupported invented content and marks it doubtful", () => {
    const invented: ModelInterpretation = { ...output, questions: [{ ...output.questions[0]!, statement: "Texto que no existe", options: [...output.questions[0]!.options, { letter: "E", text: "Opción inventada" }] }], answers: [] };
    const block = anchorInterpretation(invented, ref, sourcePages);
    expect(block.questions[0]?.statement).toBe("");
    expect(block.questions[0]?.options).toHaveLength(4);
    expect(block.questions[0]?.issues).toContain("contenido_no_verificado");
  });

  it("grounds wording despite accents, punctuation and PDF line breaks", () => {
    const source = "37. ¿Qué condición\npresenta el archivo?\nA) Un registro\nB) Dos registros";
    expect(groundedSpan("Que condicion presenta el archivo?", source)?.text).toBe("Qué condición presenta el archivo?");
    expect(groundedSpan("internacional", "inter-\nnacional")?.text).toBe("internacional");
    expect(groundedSpan("Un dato inventado", source)).toBeNull();
  });

  it("recovers an empty statement and duplicate model labels only from numbered source lines", () => {
    const extracted = page(8, "37. ¿Qué condición presenta el archivo?\nA) Un registro\nB) Dos registros\nC) Tres registros\nD) Cuatro registros\n38. ¿Qué sigue?\nA) Sí\nB) No");
    const candidate: ModelInterpretation = { classification: "preguntas", issues: [], answers: [], questions: [{
      printedNumber: "37", section: "ordinaria", statement: "", subparts: [], tables: [], pages: [8], confidence: 0.8,
      options: [{ letter: "A", text: "Un registro" }, { letter: "B", text: "Dos registros" },
        { letter: "B", text: "Tres registros" }, { letter: "D", text: "Cuatro registros" }],
      issues: ["texto_incompleto", "opciones_incompletas"],
    }] };
    const block = anchorInterpretation(candidate, { ...ref, corePages: [8], contextPages: [8] }, [extracted]);
    expect(block.questions[0]?.statement).toBe("¿Qué condición presenta el archivo?");
    expect(block.questions[0]?.options.map((option) => option.letter)).toEqual(["A", "B", "C", "D"]);
    expect(block.questions[0]?.issues).not.toContain("texto_incompleto");
    expect(block.questions[0]?.issues).not.toContain("opciones_incompletas");
  });

  it("does not recover from ambiguous numbering or an option list without source labels", () => {
    const ambiguous = page(8, "37. Primera pregunta\nA) Uno\nB) Dos\n37. Otra pregunta\nA) Tres\nB) Cuatro");
    expect(recoverQuestionFromSource([ambiguous], 8, "37")).toBeNull();
    const unlabeled = page(8, "37. Pregunta sin letras\nUno\nDos");
    expect(recoverQuestionFromSource([unlabeled], 8, "37")).toBeNull();
  });

  it("recovers only the numbered question when its options continue on the next page", () => {
    const first = page(1, "5. ¿Qué elemento conserva los documentos?\nA) Archivo\nB) Almacén");
    const second = page(2, "C) Biblioteca\nD) Depósito\n6. ¿Cuál es el siguiente?\nA) Primero\nB) Segundo");
    expect(recoverQuestionFromSource([first, second], 1, "5")).toEqual({
      statement: "¿Qué elemento conserva los documentos?",
      options: [{ letter: "A", text: "Archivo" }, { letter: "B", text: "Almacén" },
        { letter: "C", text: "Biblioteca" }, { letter: "D", text: "Depósito" }],
      pages: [1, 2],
    });
  });
});

describe("OCR-04 strict JSON", () => {
  const valid = JSON.stringify({ classification: "desconocido", issues: [], questions: [], answers: [] });
  it("repairs invalid JSON once", async () => {
    let calls = 0;
    const result = await parseWithSingleRepair("{invalid", async () => { calls += 1; return valid; });
    expect(result.questions).toEqual([]);
    expect(calls).toBe(1);
  });
  it("does not make a second repair attempt", async () => {
    let calls = 0;
    await expect(parseWithSingleRepair("{invalid", async () => { calls += 1; return "still invalid"; })).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it("rejects an incomplete schema", async () => {
    await expect(parseWithSingleRepair('{"questions":[]}', async () => valid)).resolves.toMatchObject({ classification: "desconocido" });
  });
});
