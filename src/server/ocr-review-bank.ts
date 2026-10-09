import { HTTPError } from "nitro";

const SUPABASE_URL = "https://zinocrzgztenwhyhjxyp.supabase.co";

async function bankRead<T>(path: string): Promise<T> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new HTTPError("Falta configurar SUPABASE_SERVICE_ROLE_KEY en Production", { status: 503 });
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!response?.ok) throw new HTTPError("No se pudo consultar el banco privado", { status: 503 });
  return response.json() as Promise<T>;
}

interface RegistryRow { exam_id: string; destination: "oficiales" | "otros"; }
interface ExamRow { id: string; titulo: string | null; organismo: string | null; año: number | null; categoria: string | null; ocr06_destino: "oficiales" | "otros"; created_at: string; }
interface QuestionRow { id: string; examen_id: string; [key: string]: unknown; }

export async function listOwnedOcr06Exams(owner: string): Promise<Array<ExamRow & { preguntas: Array<{ count: number }> }>> {
  const registry = await bankRead<RegistryRow[]>(`ocr06_imports?owner_id=eq.${encodeURIComponent(owner)}&select=exam_id,destination&limit=500`);
  if (!registry.length) return [];
  const ids = registry.map(row => row.exam_id).filter(id => /^[0-9a-f-]{36}$/iu.test(id));
  if (!ids.length) return [];
  const inList = `in.(${ids.join(",")})`;
  const [exams, questions] = await Promise.all([
    bankRead<ExamRow[]>(`examenes_subidos?id=${inList}&select=*`),
    bankRead<Array<Pick<QuestionRow, "examen_id">>>(`preguntas?examen_id=${inList}&select=examen_id`),
  ]);
  return exams.map(exam => ({ ...exam, preguntas: [{ count: questions.filter(question => question.examen_id === exam.id).length }] }));
}

export async function listOwnedOcr06Questions(owner: string, examId: string): Promise<QuestionRow[]> {
  if (!/^[0-9a-f-]{36}$/iu.test(examId)) throw new HTTPError("Examen no encontrado", { status: 404 });
  const registry = await bankRead<RegistryRow[]>(`ocr06_imports?owner_id=eq.${encodeURIComponent(owner)}&exam_id=eq.${encodeURIComponent(examId)}&select=exam_id,destination&limit=1`);
  if (!registry.length) throw new HTTPError("Examen no encontrado", { status: 404 });
  return bankRead<QuestionRow[]>(`preguntas?examen_id=eq.${encodeURIComponent(examId)}&select=*&order=created_at.asc`);
}
