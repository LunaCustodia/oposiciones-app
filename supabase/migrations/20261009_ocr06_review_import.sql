-- OCR-06: bank compatibility, private provenance, and one-transaction confirmation.
alter table public.examenes_subidos alter column titulo drop not null;
alter table public.examenes_subidos add column if not exists ocr06_destino text
  check (ocr06_destino in ('oficiales', 'otros'));

alter table public.preguntas alter column opcion_a drop not null;
alter table public.preguntas alter column opcion_b drop not null;
alter table public.preguntas alter column opcion_c drop not null;
alter table public.preguntas alter column opcion_d drop not null;
alter table public.preguntas alter column respuesta_correcta drop not null;
alter table public.preguntas drop constraint if exists preguntas_respuesta_correcta_check;
alter table public.preguntas alter column respuesta_correcta type varchar(4);
alter table public.preguntas add constraint preguntas_respuesta_correcta_ocr06_check
  check (respuesta_correcta is null or respuesta_correcta ~ '^[a-zA-Z]{1,4}$');

create table if not exists public.ocr06_imports (
  import_id uuid primary key,
  owner_id text not null,
  exam_id uuid not null unique references public.examenes_subidos(id) on delete cascade,
  destination text not null check (destination in ('oficiales', 'otros')),
  created_at timestamptz not null default now()
);
create index if not exists ocr06_imports_owner_idx on public.ocr06_imports(owner_id);
alter table public.ocr06_imports enable row level security;
revoke all on public.ocr06_imports from public, anon, authenticated;
grant select, insert, delete on public.ocr06_imports to service_role;

create table if not exists public.ocr06_question_details (
  question_id uuid primary key references public.preguntas(id) on delete cascade,
  import_id uuid not null references public.ocr06_imports(import_id) on delete cascade,
  owner_id text not null,
  printed_number text not null,
  section text not null check (section in ('ordinaria', 'reserva')),
  options jsonb not null,
  subparts jsonb not null,
  tables jsonb not null,
  detected jsonb not null,
  corrected jsonb,
  question_source jsonb not null,
  answer_evidence jsonb not null,
  created_at timestamptz not null default now(),
  unique(import_id, section, printed_number)
);
create index if not exists ocr06_details_import_idx on public.ocr06_question_details(import_id);
alter table public.ocr06_question_details enable row level security;
revoke all on public.ocr06_question_details from public, anon, authenticated;
grant select, insert, delete on public.ocr06_question_details to service_role;

create or replace function public.ocr06_commit_import(p_payload jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_import_id uuid := (p_payload->>'importId')::uuid;
  v_owner text := p_payload->>'ownerId';
  v_destination text := p_payload->>'destination';
  v_exam_id uuid;
  v_question_id uuid;
  v_question jsonb;
  v_value jsonb;
  v_options jsonb;
  v_answer text;
begin
  if v_owner is null or length(v_owner) < 32 or v_destination not in ('oficiales', 'otros')
    or jsonb_typeof(p_payload->'questions') <> 'array'
    or jsonb_array_length(p_payload->'questions') = 0 then
    raise exception 'invalid_ocr06_payload';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_import_id::text, 0));
  select exam_id into v_exam_id from public.ocr06_imports where import_id = v_import_id and owner_id = v_owner;
  if v_exam_id is not null then return v_exam_id; end if;
  if exists (select 1 from public.ocr06_imports where import_id = v_import_id) then
    raise exception 'ocr06_import_owner_mismatch';
  end if;

  insert into public.examenes_subidos(titulo, organismo, "año", categoria, ocr06_destino)
  values (p_payload#>>'{metadata,titulo}', p_payload#>>'{metadata,organismo}',
    nullif(p_payload#>>'{metadata,año}', '')::integer, p_payload#>>'{metadata,categoria}', v_destination)
  returning id into v_exam_id;
  insert into public.ocr06_imports(import_id, owner_id, exam_id, destination)
  values (v_import_id, v_owner, v_exam_id, v_destination);

  for v_question in select value from pg_catalog.jsonb_array_elements(p_payload->'questions') loop
    v_value := v_question->'value';
    v_options := v_value->'options';
    v_answer := case when v_value->>'resolution' = 'anulada' then null else lower(v_value->>'answer') end;
    insert into public.preguntas(examen_id, tema_codigo, enunciado,
      opcion_a, opcion_b, opcion_c, opcion_d, respuesta_correcta, origen, "año", anulada)
    values (v_exam_id, 'OCR06', v_value->>'statement',
      (select item->>'text' from pg_catalog.jsonb_array_elements(v_options) item where upper(item->>'letter') = 'A' limit 1),
      (select item->>'text' from pg_catalog.jsonb_array_elements(v_options) item where upper(item->>'letter') = 'B' limit 1),
      (select item->>'text' from pg_catalog.jsonb_array_elements(v_options) item where upper(item->>'letter') = 'C' limit 1),
      (select item->>'text' from pg_catalog.jsonb_array_elements(v_options) item where upper(item->>'letter') = 'D' limit 1),
      v_answer, p_payload#>>'{metadata,organismo}', nullif(p_payload#>>'{metadata,año}', '')::integer,
      v_value->>'resolution' = 'anulada')
    returning id into v_question_id;
    insert into public.ocr06_question_details(question_id, import_id, owner_id, printed_number, section,
      options, subparts, tables, detected, corrected, question_source, answer_evidence)
    values (v_question_id, v_import_id, v_owner, v_value->>'number', v_value->>'section',
      v_options, v_value->'subparts', v_value->'tables', v_question->'detected', v_question->'corrected',
      v_question->'source', v_question->'evidence');
  end loop;
  return v_exam_id;
end;
$$;
revoke all on function public.ocr06_commit_import(jsonb) from public, anon, authenticated;
grant execute on function public.ocr06_commit_import(jsonb) to service_role;
