import { describe, expect, it } from "vitest";
import type { ReviewQuestion, ReviewView } from "../src/shared/ocr-review.js";
import { validateReview, validateValue } from "../src/server/ocr-review.js";

const question = (id: string, section: "ordinaria" | "reserva" = "ordinaria"): ReviewQuestion => {
  const value = { number: "1", section, statement: "¿Prueba técnica?", subparts: [],
    options: [{ letter: "A", text: "Sí" }, { letter: "B", text: "No" }], tables: [],
    answer: "A", resolution: "respuesta" as const };
  return { id, value, detected: structuredClone(value), corrected: null, source: {
    id, printedNumber: "1", section, statement: value.statement, subparts: [], options: value.options,
    tables: [], fileId: "technical", originalName: "technical.pdf", pages: [1], confidence: 1, issues: [],
  }, evidence: [], initialState: "vinculada", issues: [] };
};

const review = (questions: ReviewQuestion[], orphans: ReviewView["orphans"] = []): ReviewView => ({
  importId: "technical", metadata: { titulo: null, año: null, organismo: null, categoria: null },
  destination: "oficiales", questions, orphans, blockers: [], updatedAt: null, imported: null,
});

describe("OCR-06 directed review validation", () => {
  it("keeps ordinary and reserve number 1 distinct, but rejects same-section duplicates", () => {
    expect(validateReview(review([question("a"), question("b", "reserva")]))).toEqual([]);
    expect(validateReview(review([question("a"), question("b")])).some(b => b.message.includes("duplicados"))).toBe(true);
  });
  it("blocks pending conflicts, ambiguous answers, missing answer and incomplete options", () => {
    const item = question("a");
    item.value.resolution = "pendiente";
    item.value.answer = null;
    item.value.options = [{ letter: "A", text: "Sí" }, { letter: "A", text: "" }];
    const messages = validateReview(review([item])).map(b => b.message).join(" ");
    expect(messages).toContain("pendiente");
    expect(messages).toContain("opciones válidas");
  });
  it("allows express annulment but blocks invalid answers", () => {
    const item = question("a");
    item.value.resolution = "anulada"; item.value.answer = null;
    expect(validateReview(review([item]))).toEqual([]);
    item.value.resolution = "respuesta"; item.value.answer = "C";
    expect(validateReview(review([item])).some(b => b.message.includes("fuera de las opciones"))).toBe(true);
  });
  it("requires each orphan to be expressly associated or discarded", () => {
    const evidence = { id: "orphan", printedNumber: "9", section: "desconocida" as const,
      answer: "A", annulled: false, ambiguous: false, method: "textual" as const,
      fileId: "technical", originalName: "technical.pdf", page: 1, coordinates: null,
      imageId: null, confidence: 1, markScores: null, issues: [] };
    const item = { evidence, decision: null };
    expect(validateReview(review([question("a")], [item])).some(b => b.message.includes("huérfana"))).toBe(true);
    item.decision = { action: "discard", questionId: null, decidedAt: new Date().toISOString(), evidenceId: "orphan" } as never;
    expect(validateReview(review([question("a")], [item]))).toEqual([]);
  });
  it("keeps edited subparts, option order and structured tables", () => {
    const value = validateValue({ ...question("a").value,
      options: [{ letter: "B", text: "No" }, { letter: "A", text: "Sí" }],
      subparts: [{ label: "a", text: "Apartado" }], tables: [{ text: "Tabla", rows: [["X", "Y"]] }] });
    expect(value.options.map(option => option.letter)).toEqual(["B", "A"]);
    expect(value.tables[0].rows[0]).toEqual(["X", "Y"]);
  });
});
