import { FatalError, RetryableError, createHook, setAttributes } from "workflow";
import type {
  ConnectionProbeResult,
  OcrJobContract,
  TechnicalProbeTarget,
  TechnicalJobResult,
  TechnicalWorkflowResult,
} from "../src/shared/ocr-job.js";
import { getSafeAvailability, probeDocumentAi, probeGemini } from "../src/server/connections.js";

function statusFromError(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
}

function throwSafeProbeError(error: unknown, connection: "Gemini" | "Document AI"): never {
  const status = statusFromError(error);
  if (status === 408 || status === 429 || (status !== undefined && status >= 500)) {
    throw new RetryableError(`${connection} no respondió temporalmente.`, { retryAfter: "5s" });
  }
  throw new FatalError(`${connection} rechazó la comprobación de conexión.`);
}

async function runTechnicalProbe(target: TechnicalProbeTarget): Promise<TechnicalJobResult> {
  "use step";

  const availability = getSafeAvailability();
  const connections: ConnectionProbeResult = {
    gemini: "pending_configuration",
    documentAi: "pending_configuration",
  };

  if (target === "all" && availability.connections.gemini) {
    try {
      await probeGemini();
      connections.gemini = "real";
    } catch (error) {
      throwSafeProbeError(error, "Gemini");
    }
  }

  let documentAiSummary: TechnicalJobResult["documentAiSummary"];
  if (availability.connections.documentAi) {
    try {
      documentAiSummary = await probeDocumentAi();
      connections.documentAi = "real";
    } catch (error) {
      throwSafeProbeError(error, "Document AI");
    }
  }

  return {
    mechanism: "vercel_workflow",
    completedAt: new Date().toISOString(),
    connections,
    documentAiSummary,
  };
}

runTechnicalProbe.maxRetries = 2;

export async function ocr01TechnicalWorkflow(
  job: OcrJobContract,
  hookToken: string,
  target: TechnicalProbeTarget = "all",
): Promise<TechnicalWorkflowResult> {
  "use workflow";

  const ownership = createHook({
    token: hookToken,
    experimental_minRetention: "30d",
  });
  const conflict = await ownership.getConflict();
  if (conflict) {
    return { kind: "duplicate", job, ownerRunId: conflict.runId };
  }

  await setAttributes({
    jobKey: hookToken,
    ownerId: job.ownerId,
    state: "procesando",
    stage: "comprobacion_tecnica",
  });

  const result = await runTechnicalProbe(target);
  const completedJob: OcrJobContract = {
    ...job,
    state: "completado",
    stage: "comprobacion_tecnica_completada",
    updatedAt: result.completedAt,
    error: null,
  };

  await setAttributes({
    state: completedJob.state,
    stage: completedJob.stage,
  });

  return { kind: "completed", job: completedJob, result };
}
