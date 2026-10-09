import { FatalError, RetryableError, createHook, setAttributes } from "workflow";
import type {
  OcrExtractionWorkflowResult,
  OcrFallbackPage,
  OcrPreparedFile,
} from "../src/shared/ocr-extraction.js";
import { extractPageWithDocumentAi, isTransientDocumentAiError } from "../src/server/document-ai-extraction.js";
import {
  finalizeExtraction,
  markExtractionFailure,
  readExtractionStatus,
  readPageExtraction,
  readPrivateImportPdf,
  refreshFileProgressFromPages,
  setExtractionStage,
  updateFileProgress,
  writePageExtraction,
} from "../src/server/ocr-extractions.js";
import { completePreparedFile, preparePdfExtraction } from "../src/server/pdf-extraction.js";
import { readImport } from "../src/server/ocr-imports.js";

function rethrowStepFailure(error: unknown): never {
  if (error instanceof FatalError || error instanceof RetryableError) throw error;
  if (isTransientDocumentAiError(error)) {
    throw new RetryableError("Un servicio de extracción no respondió temporalmente.", { retryAfter: "5s" });
  }
  throw new FatalError("La operación de extracción no se pudo completar.");
}

async function loadExtractionFiles(ownerId: string, importId: string): Promise<string[]> {
  "use step";
  console.info("OCR-03: preparando lista privada de archivos");
  try {
    const manifest = await readImport(ownerId, importId);
    if (!manifest || manifest.state !== "lista") throw new FatalError("La importación no está disponible.");
    await setExtractionStage(ownerId, importId, "procesando", "analizando_pdf");
    return [...manifest.files].sort((left, right) => left.order - right.order).map((file) => file.id);
  } catch (error) {
    rethrowStepFailure(error);
  }
}

loadExtractionFiles.maxRetries = 2;

async function prepareFile(ownerId: string, importId: string, fileId: string): Promise<OcrPreparedFile> {
  "use step";
  console.info("OCR-03: evaluando extracción directa de un archivo");
  try {
    return await preparePdfExtraction(ownerId, importId, fileId);
  } catch (error) {
    rethrowStepFailure(error);
  }
}

prepareFile.maxRetries = 2;

async function processDocumentAiPage(
  ownerId: string,
  importId: string,
  fileId: string,
  sha256: string,
  pageCount: number,
  fallback: OcrFallbackPage,
): Promise<{ ok: boolean; safeError?: string }> {
  "use step";
  console.info("OCR-03: procesando una página con Document AI", { pageNumber: fallback.pageNumber });
  const existing = await readPageExtraction(ownerId, importId, fileId, fallback.pageNumber);
  if (existing?.sourceSha256 === sha256 && existing.method === "document_ai") {
    await refreshFileProgressFromPages(ownerId, importId, fileId, pageCount);
    return existing.quality.valid ? { ok: true } : { ok: false, safeError: "Document AI no devolvió texto utilizable." };
  }

  try {
    const { file, bytes } = await readPrivateImportPdf(ownerId, importId, fileId);
    const result = await extractPageWithDocumentAi({
      ownerId,
      importId,
      fileId,
      originalName: file.originalName,
      fileOrder: file.order,
      pageNumber: fallback.pageNumber,
      sourceSha256: sha256,
      sourcePdf: bytes,
      reason: fallback.reason,
    });
    await writePageExtraction(ownerId, result);
    await refreshFileProgressFromPages(ownerId, importId, fileId, pageCount);
    return result.quality.valid
      ? { ok: true }
      : { ok: false, safeError: "Document AI no devolvió texto utilizable." };
  } catch (error) {
    if (isTransientDocumentAiError(error)) {
      throw new RetryableError("Document AI no respondió temporalmente.", { retryAfter: "5s" });
    }
    return { ok: false, safeError: "No se pudo extraer esta página con Document AI." };
  }
}

processDocumentAiPage.maxRetries = 2;

async function recordPageFailure(
  ownerId: string,
  importId: string,
  fileId: string,
  pageNumber: number,
  pageCount: number,
): Promise<void> {
  "use step";
  console.warn("OCR-03: página marcada para revisión", { pageNumber });
  try {
    const status = await readExtractionStatus(ownerId, importId);
    const file = status?.files.find((candidate) => candidate.fileId === fileId);
    if (!file) throw new FatalError("No existe el progreso del archivo.");
    const errorPages = [...new Set([...file.errorPages, pageNumber])].sort((left, right) => left - right);
    await updateFileProgress(ownerId, importId, fileId, {
      state: "revision",
      totalPages: pageCount,
      errorPages,
      processedPages: file.directPages + file.documentAiPages + errorPages.length,
      currentPage: pageNumber < pageCount ? pageNumber + 1 : null,
    });
  } catch (error) {
    rethrowStepFailure(error);
  }
}

recordPageFailure.maxRetries = 2;

async function finishFile(ownerId: string, importId: string, prepared: OcrPreparedFile): Promise<void> {
  "use step";
  console.info("OCR-03: consolidando resultado de archivo");
  try {
    await completePreparedFile(ownerId, importId, prepared.fileId, prepared.sha256, prepared.pageCount);
  } catch (error) {
    rethrowStepFailure(error);
  }
}

finishFile.maxRetries = 2;

async function recordFileFailure(ownerId: string, importId: string, fileId: string): Promise<void> {
  "use step";
  console.warn("OCR-03: archivo marcado para revisión");
  try {
    await updateFileProgress(ownerId, importId, fileId, {
      state: "error",
      errorPages: [1],
      processedPages: 1,
      currentPage: null,
    });
  } catch (error) {
    rethrowStepFailure(error);
  }
}

recordFileFailure.maxRetries = 2;

async function finishExtraction(ownerId: string, importId: string) {
  "use step";
  console.info("OCR-03: finalizando extracción documental");
  try {
    return await finalizeExtraction(ownerId, importId);
  } catch (error) {
    rethrowStepFailure(error);
  }
}

finishExtraction.maxRetries = 2;

async function failExtraction(ownerId: string, importId: string): Promise<void> {
  "use step";
  console.error("OCR-03: fallo global controlado");
  await markExtractionFailure(ownerId, importId);
}

failExtraction.maxRetries = 1;

export async function ocr03ExtractionWorkflow(
  ownerId: string,
  importId: string,
  hookToken: string,
): Promise<OcrExtractionWorkflowResult> {
  "use workflow";
  console.info("OCR-03: workflow iniciado");

  const ownership = createHook({ token: hookToken, experimental_minRetention: "30d" });
  const conflict = await ownership.getConflict();
  if (conflict) return { kind: "duplicate", importId, ownerRunId: conflict.runId };

  await setAttributes({ importId, state: "procesando", stage: "analizando_pdf" });
  try {
    const fileIds = await loadExtractionFiles(ownerId, importId);
    for (const fileId of fileIds) {
      let prepared: OcrPreparedFile;
      try {
        prepared = await prepareFile(ownerId, importId, fileId);
      } catch {
        await recordFileFailure(ownerId, importId, fileId);
        continue;
      }
      if (prepared.cached) continue;

      for (const fallback of prepared.fallbackPages) {
        let outcome: { ok: boolean; safeError?: string };
        try {
          outcome = await processDocumentAiPage(
            ownerId,
            importId,
            fileId,
            prepared.sha256,
            prepared.pageCount,
            fallback,
          );
        } catch {
          outcome = { ok: false, safeError: "Document AI agotó los reintentos temporales." };
        }
        if (!outcome.ok) {
          await recordPageFailure(ownerId, importId, fileId, fallback.pageNumber, prepared.pageCount);
        }
      }
      await finishFile(ownerId, importId, prepared);
    }

    const finalStatus = await finishExtraction(ownerId, importId);
    await setAttributes({ state: finalStatus.state, stage: finalStatus.stage });
    return { kind: "completed", importId, state: finalStatus.state };
  } catch {
    await failExtraction(ownerId, importId);
    await setAttributes({ state: "error", stage: "fallo_extraccion" });
    return { kind: "completed", importId, state: "error" };
  }
}
