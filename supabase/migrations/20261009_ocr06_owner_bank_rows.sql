-- Keep legacy bank rows unchanged; OCR-06 rows are readable only through the authenticated server.
alter table public.preguntas add column if not exists ocr06_import_id uuid
  references public.ocr06_imports(import_id) on delete cascade;
create index if not exists preguntas_ocr06_import_idx on public.preguntas(ocr06_import_id)
  where ocr06_import_id is not null;

drop policy if exists "Acceso total examenes_subidos" on public.examenes_subidos;
create policy "Acceso legado examenes_subidos" on public.examenes_subidos
  for all to public using (ocr06_destino is null) with check (ocr06_destino is null);
drop policy if exists "Acceso total preguntas" on public.preguntas;
create policy "Acceso legado preguntas" on public.preguntas
  for all to public using (ocr06_import_id is null) with check (ocr06_import_id is null);

-- The previous fail-closed guard is superseded by row-level isolation above.
drop trigger if exists ocr06_private_bank_guard on public.ocr06_imports;
drop function if exists public.ocr06_require_private_bank();

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
    insert into public.preguntas(examen_id, ocr06_import_id, tema_codigo, enunciado,
      opcion_a, opcion_b, opcion_c, opcion_d, respuesta_correcta, origen, "año", anulada)
    values (v_exam_id, v_import_id, 'OCR06', v_value->>'statement',
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
