import { ApiError } from '@/lib/api/client';

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Ocurrió un error inesperado';
}

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="banner banner-danger" style={{ marginBottom: 'var(--s-4)' }}>{errorMessage(error)}</div>;
}

export function Loading({ text = 'Cargando…' }: { text?: string }) {
  return <div style={{ padding: 'var(--s-6)', color: 'var(--fg-3)', fontSize: 'var(--text-sm)' }}>{text}</div>;
}
