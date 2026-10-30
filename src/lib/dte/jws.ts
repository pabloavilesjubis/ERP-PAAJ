/**
 * El DTE firmado (JWS compacto) lleva el JSON original en el payload. Se
 * decodifica como UTF-8: atob() solo da bytes latin1 y "Peñate" saldría "PeÃ±ate".
 */
export function dteFromJws(jws: string | undefined | null): Record<string, unknown> | null {
  const payload = jws?.split('.')[1];
  if (!payload) return null;
  try {
    const bin = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(new TextDecoder('utf-8').decode(Uint8Array.from(bin, c => c.charCodeAt(0)))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** JSON del DTE como lo entrega el MH: el documento con su firma y el sello de recepción. */
export function dteJsonDocument(jws: string, selloRecibido: string | null | undefined): Record<string, unknown> | null {
  const dte = dteFromJws(jws);
  return dte ? { ...dte, firmaElectronica: jws, selloRecibido: selloRecibido ?? null } : null;
}

export function downloadJsonFile(filename: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
