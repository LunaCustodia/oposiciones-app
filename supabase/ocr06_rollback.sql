-- Run only after deleting OCR-06 imports and their bank exams.
do $$ begin
  if exists(select 1 from public.ocr06_imports) then
    raise exception 'delete_or_archive_ocr06_exams_before_rollback';
  end if;
  if exists(select 1 from public.examenes_subidos where titulo is null) or
    exists(select 1 from public.preguntas where opcion_a is null or opcion_b is null or opcion_c is null or opcion_d is null or respuesta_correcta is null or length(respuesta_correcta) <> 1) then
    raise exception 'legacy_not_null_constraints_cannot_be_restored';
  end if;
end $$;
drop function if exists public.ocr06_commit_import(jsonb);
drop trigger if exists ocr06_private_bank_guard on public.ocr06_imports;
drop function if exists public.ocr06_require_private_bank();
drop policy if exists "Acceso legado examenes_subidos" on public.examenes_subidos;
drop policy if exists "Acceso legado preguntas" on public.preguntas;
create policy "Acceso total examenes_subidos" on public.examenes_subidos
  for all to public using (true) with check (true);
create policy "Acceso total preguntas" on public.preguntas
  for all to public using (true) with check (true);
drop table if exists public.ocr06_question_details;
alter table public.preguntas drop column if exists ocr06_import_id;
drop table if exists public.ocr06_imports;
alter table public.examenes_subidos drop column if exists ocr06_destino;
alter table public.examenes_subidos alter column titulo set not null;
alter table public.preguntas drop constraint if exists preguntas_respuesta_correcta_ocr06_check;
alter table public.preguntas alter column respuesta_correcta type char(1);
alter table public.preguntas add constraint preguntas_respuesta_correcta_check
  check (respuesta_correcta in ('a','b','c','d'));
alter table public.preguntas alter column opcion_a set not null;
alter table public.preguntas alter column opcion_b set not null;
alter table public.preguntas alter column opcion_c set not null;
alter table public.preguntas alter column opcion_d set not null;
alter table public.preguntas alter column respuesta_correcta set not null;
