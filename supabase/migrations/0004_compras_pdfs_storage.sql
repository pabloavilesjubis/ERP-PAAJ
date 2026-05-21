-- =============================================================
-- ABX Pyme — Storage para PDFs de compras
-- Crea un bucket privado donde se almacenan los PDFs adjuntos a cada
-- compra. Las políticas aseguran que cada usuario solo accede a los
-- archivos que pertenecen a sus empresas.
--
-- Convención de path:
--    {company_id}/{compra_id}.pdf
--
-- La primera carpeta (company_id) se usa para evaluar la policy.
-- =============================================================

insert into storage.buckets (id, name, public)
values ('compras-pdfs', 'compras-pdfs', false)
on conflict (id) do nothing;

drop policy if exists "compras_pdfs_select" on storage.objects;
drop policy if exists "compras_pdfs_insert" on storage.objects;
drop policy if exists "compras_pdfs_update" on storage.objects;
drop policy if exists "compras_pdfs_delete" on storage.objects;

create policy "compras_pdfs_select"
  on storage.objects for select
  using (
    bucket_id = 'compras-pdfs'
    and (storage.foldername(name))[1] in (
      select c.id::text from public.companies c where c.owner_id = auth.uid()
    )
  );

create policy "compras_pdfs_insert"
  on storage.objects for insert
  with check (
    bucket_id = 'compras-pdfs'
    and (storage.foldername(name))[1] in (
      select c.id::text from public.companies c where c.owner_id = auth.uid()
    )
  );

create policy "compras_pdfs_update"
  on storage.objects for update
  using (
    bucket_id = 'compras-pdfs'
    and (storage.foldername(name))[1] in (
      select c.id::text from public.companies c where c.owner_id = auth.uid()
    )
  )
  with check (
    bucket_id = 'compras-pdfs'
    and (storage.foldername(name))[1] in (
      select c.id::text from public.companies c where c.owner_id = auth.uid()
    )
  );

create policy "compras_pdfs_delete"
  on storage.objects for delete
  using (
    bucket_id = 'compras-pdfs'
    and (storage.foldername(name))[1] in (
      select c.id::text from public.companies c where c.owner_id = auth.uid()
    )
  );
