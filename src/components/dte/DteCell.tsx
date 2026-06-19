import type { CSSProperties } from 'react';

/**
 * Las 3 celdas con los valores fiscales EXACTOS que usa Hacienda por cada DTE
 * (número de control, código de generación, sello) + botones PDF / JSON.
 *
 * PDF  → consulta pública del MH (factura.gob.sv): PDF oficial por codigoGeneracion.
 * JSON → si tenemos el DTE firmado (documentoJws) lo decodificamos y descargamos
 *        el JSON canónico; si no, también va a la consulta pública del MH.
 *
 * `DteCells` devuelve un fragmento con <td>×3 — colocalo dentro de un <tr> y
 * agregá los 3 <th> (Nº Control, Cód. Generación, Sello).
 */

const cell: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: '11px',
  wordBreak: 'break-all',
  color: 'var(--fg-2)',
};
const linkStyle: CSSProperties = { fontSize: '11px', color: '#2563eb', textDecoration: 'none', cursor: 'pointer' };
const btnStyle: CSSProperties = { ...linkStyle, background: 'none', border: 'none', padding: 0, font: 'inherit' };
const dash = <span style={{ color: 'var(--fg-4)' }}>—</span>;

/** URL de la consulta pública del MH (factura.gob.sv) → PDF + JSON oficiales. */
export function mhFacturaUrl(
  codigoGeneracion?: string,
  fecha?: string,
  ambiente = '01',
): string | null {
  if (!codigoGeneracion) return null;
  const fechaEmi = (fecha ?? '').slice(0, 10);
  const f = fechaEmi ? `&fechaEmi=${fechaEmi}` : '';
  return `https://admin.factura.gob.sv/consultapublica?ambiente=${ambiente}&codGen=${encodeURIComponent(codigoGeneracion)}${f}`;
}

/** Decodifica el payload del JWS (= el DTE JSON canónico) y lo descarga. */
function downloadDteJson(jws: string, numeroControl?: string): void {
  try {
    const parts = jws.split('.');
    const payload = parts.length >= 2 ? parts[1]! : parts[0]!;
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    const decoded = new TextDecoder('utf-8').decode(bytes);
    const pretty = JSON.stringify(JSON.parse(decoded), null, 2);
    const blob = new Blob([pretty], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(numeroControl || 'dte').replace(/[^A-Za-z0-9-]/g, '_')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  } catch {
    // eslint-disable-next-line no-alert
    alert('No se pudo decodificar el JSON de este DTE.');
  }
}

export interface DteFiscalMeta {
  numeroControl?: string;
  codigoGeneracion?: string;
  /** En ventas a contribuyente el código de generación se guarda acá. */
  numeroDocumento?: string;
  selloRecibido?: string;
  /** DTE firmado (JWS). Su payload es el JSON canónico — para descarga. */
  documentoJws?: string;
}

/** Fragmento de 3 <td>: número de control (+ PDF/JSON), código de generación, sello. */
export function DteCells({ meta, fecha }: { meta?: DteFiscalMeta; fecha?: string }) {
  const m = meta ?? {};
  // Consumidor usa `codigoGeneracion`; contribuyente lo guarda en `numeroDocumento`.
  const codGen = m.codigoGeneracion || m.numeroDocumento;
  const url = mhFacturaUrl(codGen, fecha);
  const jws = m.documentoJws;

  return (
    <>
      <td style={cell}>
        <div>{m.numeroControl || dash}</div>
        {(url || jws) && (
          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            {url && (
              <a href={url} target="_blank" rel="noreferrer" style={linkStyle} title="Ver / descargar el PDF oficial en el MH">
                PDF ↗
              </a>
            )}
            {jws ? (
              <button type="button" style={btnStyle} onClick={() => downloadDteJson(jws, m.numeroControl)} title="Descargar el JSON firmado del DTE">
                JSON ⬇
              </button>
            ) : url && (
              <a href={url} target="_blank" rel="noreferrer" style={linkStyle} title="Ver / descargar el JSON oficial en el MH">
                JSON ↗
              </a>
            )}
          </div>
        )}
      </td>
      <td style={cell}>{codGen || dash}</td>
      <td style={cell}>{m.selloRecibido || dash}</td>
    </>
  );
}
