import type { CSSProperties } from 'react';

/**
 * Las 3 celdas con los valores fiscales EXACTOS que usa Hacienda por cada DTE:
 *   - Número de control  (DTE-NN-XXXX-NNNNNNNNNNNNNNN)
 *   - Código de generación (UUID)
 *   - Sello de recepción
 * Más un enlace a la consulta pública del MH (PDF + JSON oficiales).
 *
 * `DteCells` devuelve un fragmento con <td>×3 — colocalo dentro de un <tr>,
 * y agregá los 3 <th> correspondientes (Nº Control, Cód. Generación, Sello).
 */

const cell: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: '11px',
  wordBreak: 'break-all',
  color: 'var(--fg-2)',
};
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

export interface DteFiscalMeta {
  numeroControl?: string;
  codigoGeneracion?: string;
  selloRecibido?: string;
}

/** Fragmento de 3 <td>: número de control, código de generación, sello. */
export function DteCells({ meta, fecha }: { meta?: DteFiscalMeta; fecha?: string }) {
  const m = meta ?? {};
  const url = mhFacturaUrl(m.codigoGeneracion, fecha);
  return (
    <>
      <td style={cell}>
        {m.numeroControl || dash}
        {url && (
          <>
            {' '}
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              style={{ color: '#2563eb', textDecoration: 'none', whiteSpace: 'nowrap' }}
              title="Abrir factura en la consulta pública del MH (PDF + JSON)"
            >
              ↗
            </a>
          </>
        )}
      </td>
      <td style={cell}>{m.codigoGeneracion || dash}</td>
      <td style={cell}>{m.selloRecibido || dash}</td>
    </>
  );
}
