import { HTTPError } from "nitro";
import { getReview, markImported, reviewContext, validateReview } from "./ocr-review.js";

const SUPABASE_URL = "https://zinocrzgztenwhyhjxyp.supabase.co";

export async function isImportedInBank(importId: string): Promise<boolean> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return false;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/ocr06_imports?import_id=eq.${encodeURIComponent(importId)}&select=exam_id&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!response?.ok) throw new HTTPError("No se puede verificar si el examen está importado", { status: 503 });
  const rows = await response.json().catch(() => null);
  if (!Array.isArray(rows)) throw new HTTPError("No se puede verificar si el examen está importado", { status: 503 });
  return rows.length > 0;
}

export async function confirmReviewedImport(owner: string, importId: string): Promise<{ examId: string; destination: "oficiales" | "otros"; deduplicated: boolean }> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new HTTPError("Falta configurar SUPABASE_SERVICE_ROLE_KEY en Production", { status: 503 });
  const { binding } = await reviewContext(owner, importId);
  const view = await getReview(owner, importId);
  if (view.imported) return { examId: view.imported.examId, destination: view.imported.destination, deduplicated: true };
  const blockers = validateReview(view);
  if (blockers.length) throw new HTTPError("La revisión contiene bloqueos; corrígelos antes de importar", { status: 409 });
  const payload = {
    importId, ownerId: owner, destination: view.destination, metadata: view.metadata,
    questions: view.questions.map(({ value, detected, corrected, source, evidence }) => ({ value, detected, corrected, source, evidence })),
  };
  let response: Response;
  try {
    response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ocr06_commit_import`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({ p_payload: payload }), signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new HTTPError("No se pudo contactar con el banco. Vuelve a intentarlo; no se duplicará el examen", { status: 503 });
  }
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as { message?: string } | null;
    if (failure?.message === "ocr06_bank_privacy_not_configured") {
      throw new HTTPError("El banco aún permite lectura anónima de exámenes y preguntas; la importación se bloqueó para proteger los datos", { status: 503 });
    }
    throw new HTTPError("La importación se revirtió por completo. Revisa los datos e inténtalo de nuevo", { status: 502 });
  }
  const examId = await response.json().catch(() => null);
  if (typeof examId !== "string" || !/^[0-9a-f-]{36}$/iu.test(examId)) {
    throw new HTTPError("No se pudo confirmar el identificador del examen; vuelve a consultar la importación", { status: 502 });
  }
  // The SQL function is idempotent even if this private marker cannot be written.
  await markImported(owner, importId, binding.fingerprint, examId, view.destination);
  return { examId, destination: view.destination, deduplicated: false };
}
