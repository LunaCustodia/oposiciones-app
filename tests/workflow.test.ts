import { waitForHook } from "@workflow/vitest";
import { describe, expect, it } from "vitest";
import { start } from "workflow/api";
import type { OcrJobContract, TechnicalWorkflowResult } from "../src/shared/ocr-job.js";
import { ocr01TechnicalWorkflow } from "../workflows/ocr01-technical.js";

describe("trabajo técnico durable", () => {
  it("persiste el resultado y evita repetir el trabajo con el mismo token", async () => {
    const now = new Date().toISOString();
    const job: OcrJobContract = {
      id: "ocr01_test",
      ownerId: "owner-test",
      privateDocumentRefs: [],
      state: "pendiente",
      stage: "en_cola",
      createdAt: now,
      updatedAt: now,
      error: null,
    };
    const hookToken = "ocr01:test-idempotency";

    const ownerRun = await start(ocr01TechnicalWorkflow, [job, hookToken]);
    await waitForHook(ownerRun, { token: hookToken });
    const duplicateRun = await start(ocr01TechnicalWorkflow, [job, hookToken]);

    const ownerResult = await ownerRun.returnValue as TechnicalWorkflowResult;
    const duplicateResult = await duplicateRun.returnValue as TechnicalWorkflowResult;

    expect(ownerResult.kind).toBe("completed");
    expect(ownerResult.job.state).toBe("completado");
    expect(ownerResult.result?.mechanism).toBe("vercel_workflow");
    expect(ownerResult.result?.connections).toEqual({
      gemini: "pending_configuration",
      documentAi: "pending_configuration",
    });
    expect(duplicateResult).toMatchObject({
      kind: "duplicate",
      ownerRunId: ownerRun.runId,
    });
  });
});
