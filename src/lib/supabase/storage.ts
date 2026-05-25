/**
 * Stub no-op. PIPELINE ERP SaaS NO usa Supabase Storage para PDFs de compras.
 * Cuando se necesite upload de PDFs por tenant, reimplementar como POST
 * multipart al backend `/v2/compras/:id/pdf` que guarde en filesystem
 * (`/app/data/files/tenants/<tenant_id>/compras/`).
 *
 * Por ahora estas funciones son no-op para que `ComprasPage` legacy compile.
 */

export async function uploadCompraPdf(_compraId: string, _file: File): Promise<string> {
  throw new Error('Upload de PDFs deshabilitado en SaaS — pendiente endpoint backend');
}

export async function deleteCompraPdf(_path: string): Promise<void> {
  // no-op
}

export function openCompraPdf(_path: string): void {
  alert('Apertura de PDFs deshabilitada en SaaS — pendiente endpoint backend');
}
