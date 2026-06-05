import type { CSSProperties } from 'react';

/**
 * Celda compacta con los datos fiscales de un DTE emitido + enlace a la
 * consulta pública del MH (que entrega el PDF y el JSON oficiales por
 * codigoGeneracion, sin depender de archivos locales).
 */

const mono: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' };
const tiny: CSSProperties = { ...mono, fontSize: '10px', color: 'var(--fg-4)' };

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

export function DteCell({ meta, fecha }: { meta?: DteFiscalMeta; fecha?: string }) {
  const m = meta ?? {};
  if (!m.numeroControl && !m.codigoGeneracion) {
    return <span style={{ color: 'var(--fg-4)' }}>—</span>;
  }
  const url = mhFacturaUrl(m.codigoGeneracion, fecha);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {m.numeroControl && (
        <code style={{ ...mono, color: 'var(--fg-2)' }} title={m.numeroControl}>
          {m.numeroControl.replace(/^DTE-\d+-[^-]+-/, '#')}
        </code>
      )}
      {m.codigoGeneracion && (
        <span style={tiny} title={`Código de generación: ${m.codigoGeneracion}`}>
          {m.codigoGeneracion.slice(0, 8)}…
        </span>
      )}
      {m.selloRecibido && (
        <span style={tiny} title={`Sello de recepción: ${m.selloRecibido}`}>
          sello&nbsp;✓
        </span>
      )}
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          style={{ fontSize: '11px', color: '#2563eb', textDecoration: 'none' }}
          title="Abrir factura en la consulta pública del MH (PDF + JSON)"
        >
          Ver factura ↗
        </a>
      )}
    </div>
  );
}
