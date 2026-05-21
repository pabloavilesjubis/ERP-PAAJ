import { requireSupabase } from './client';

const BUCKET = 'compras-pdfs';

/** Resuelve el company_id del usuario autenticado (1ra empresa). */
async function getCompanyId(): Promise<string> {
  const supabase = requireSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('No hay sesión activa.');
  const { data, error } = await supabase
    .from('companies').select('id').eq('owner_id', user.id).limit(1);
  if (error) throw error;
  if (!data || !data.length) throw new Error('No se encontró tu empresa.');
  return data[0].id;
}

/**
 * Sube un PDF al bucket `compras-pdfs` con el path `{company}/{compra_id}.pdf`.
 * Devuelve el path para guardarlo en metadata.
 */
export async function uploadCompraPdf(compraId: string, file: File): Promise<string> {
  const supabase = requireSupabase();
  const companyId = await getCompanyId();
  const path = `${companyId}/${compraId}.pdf`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: file.type || 'application/pdf',
    upsert: true,
  });
  if (error) throw new Error(`Storage upload: ${error.message}`);
  return path;
}

/** Genera una URL temporal firmada (1 hora) para descargar el PDF. */
export async function getCompraPdfUrl(path: string, expiresInSec = 3600): Promise<string> {
  const supabase = requireSupabase();
  const { data, error } = await supabase.storage.from(BUCKET)
    .createSignedUrl(path, expiresInSec);
  if (error) throw new Error(`Storage signed URL: ${error.message}`);
  return data.signedUrl;
}

/** Borra el PDF del bucket (al eliminar una compra o reemplazar el archivo). */
export async function deleteCompraPdf(path: string): Promise<void> {
  const supabase = requireSupabase();
  const { error } = await supabase.storage.from(BUCKET).remove([path]);
  if (error) throw new Error(`Storage delete: ${error.message}`);
}

/** Abre el PDF en una pestaña nueva. */
export async function openCompraPdf(path: string): Promise<void> {
  const url = await getCompraPdfUrl(path);
  window.open(url, '_blank', 'noopener,noreferrer');
}
