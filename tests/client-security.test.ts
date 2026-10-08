import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("cliente OCR-01", () => {
  it("no conserva claves ni llama directamente a Gemini", async () => {
    const source = await readFile(new URL("../index.html", import.meta.url), "utf8");
    expect(source).not.toContain("generativelanguage.googleapis.com");
    expect(source).not.toContain("apiKeyGemini");
    expect(source).not.toContain('localStorage.setItem("gemini_api_key"');
    expect(source).toContain('localStorage.removeItem("gemini_api_key")');
    expect(source).toContain("/api/ocr/gemini");
  });
});
