-- Fail closed until the existing bank grants exclusive access to OCR-06 rows.
create or replace function public.ocr06_require_private_bank()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if pg_catalog.has_table_privilege('anon', 'public.examenes_subidos', 'SELECT')
    or pg_catalog.has_table_privilege('anon', 'public.preguntas', 'SELECT') then
    raise exception 'ocr06_bank_privacy_not_configured';
  end if;
  return new;
end;
$$;
revoke all on function public.ocr06_require_private_bank() from public, anon, authenticated;
drop trigger if exists ocr06_private_bank_guard on public.ocr06_imports;
create trigger ocr06_private_bank_guard
before insert on public.ocr06_imports
for each row execute function public.ocr06_require_private_bank();
