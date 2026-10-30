import { useRef, useState } from 'react';
import { env } from '@/config/env';
import { usePermissions } from '@/auth/usePermissions';
import { getAdapter } from '@/lib/data';
import type { ApiAdapter } from '@/lib/data/api-adapter';
import { downloadJsonFile, dteJsonDocument } from '@/lib/dte/jws';
import { downloadDtePdf, extractPdfData } from '@/lib/dte/pdf';
import { dteAuthHeaders } from '@/lib/dte/tenant-routing';
import { fileToBase64 } from '@/features/empresa/EmisorFields';
import { useDataStore } from '@/stores/data.store';
import type { Compra } from '@/types/domain';

type Kind = 'pdf' | 'json';

/**
 * PDF y JSON de una línea de compra. Si la compra es un FSE emitido desde el
 * POS, ambos salen del DTE firmado; si no, se usan los archivos subidos a
 * /v2/compras/:id/adjuntos, y si no hay, se ofrece subirlos.
 */
export function CompraArchivos({ compra }: { compra: Compra }) {
  const { can } = usePermissions();
  const patch = useDataStore(s => s.patch);
  const [busy, setBusy] = useState<Kind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputs = { pdf: useRef<HTMLInputElement>(null), json: useRef<HTMLInputElement>(null) };
  const m = compra.metadata ?? {};
  const jws = m.documentoJws;
  const adapter = getAdapter();
  const serverId = adapter.kind === 'api' ? (adapter as ApiAdapter).serverIdOf('compra', compra.id) : null;
  const url = (kind: Kind) => `${env.dteServiceUrl.replace(/\/$/, '')}/v2/compras/${serverId}/adjuntos/${kind}`;
  const nombreBase = (m.numeroControl || m.numeroDocumento || compra.proveedor || 'compra').replace(/[^\w.-]+/g, '_');

  async function ver(kind: Kind) {
    setError(null);
    if (jws) {
      if (kind === 'json') {
        const doc = dteJsonDocument(jws, m.selloRecibido);
        if (doc) downloadJsonFile(`${nombreBase}.json`, doc);
        return;
      }
      await downloadDtePdf(extractPdfData({
        tipo: 'fse', codigoGeneracion: m.numeroDocumento ?? '', numeroControl: m.numeroControl ?? '',
        selloRecibido: m.selloRecibido ?? null, fecha: compra.fecha, cliente: compra.proveedor,
        total: Number(compra.monto), documentoJws: jws, anulado: !!m.anulado,
      }));
      return;
    }
    // El PDF se abre en otra pestaña; se abre antes del fetch para que el navegador no la bloquee
    const tab = kind === 'pdf' ? window.open('', '_blank') : null;
    setBusy(kind);
    try {
      const res = await fetch(url(kind), { headers: dteAuthHeaders() });
      if (!res.ok) throw new Error(res.status === 404 ? 'El archivo ya no está en el servidor' : `HTTP ${res.status}`);
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      if (tab) tab.location.href = href;
      else {
        const a = document.createElement('a');
        a.href = href; a.download = compra.adjuntos?.json?.filename ?? `${nombreBase}.json`; a.click();
      }
      setTimeout(() => URL.revokeObjectURL(href), 60_000);
    } catch (e) {
      tab?.close();
      setError(e instanceof Error ? e.message : 'No se pudo abrir el archivo');
    } finally {
      setBusy(null);
    }
  }

  async function subir(kind: Kind, file: File) {
    setError(null);
    setBusy(kind);
    try {
      const res = await fetch(url(kind), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...dteAuthHeaders() },
        body: JSON.stringify({ filename: file.name, content_base64: await fileToBase64(file) }),
      });
      const body = await res.json().catch(() => null) as { message?: string; filename?: string; size?: number } | null;
      if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
      const info = { filename: body?.filename ?? file.name, size: body?.size ?? file.size };
      await patch(prev => ({
        ...prev,
        compras: prev.compras.map(c => c.id === compra.id ? { ...c, adjuntos: { ...c.adjuntos, [kind]: info } } : c),
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo subir el archivo');
    } finally {
      setBusy(null);
    }
  }

  const boton = (kind: Kind) => {
    const label = kind.toUpperCase();
    const tiene = !!jws || !!compra.adjuntos?.[kind];
    if (tiene) {
      return (
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy === kind} onClick={() => void ver(kind)}
          title={jws ? `${label} del DTE emitido` : compra.adjuntos?.[kind]?.filename}
          style={{ padding: '1px 6px', fontSize: 10 }}>
          {busy === kind ? '…' : label}
        </button>
      );
    }
    if (!serverId || !can('payables:manage')) return <span style={{ color: 'var(--fg-4)', fontSize: 'var(--text-xs)', padding: '0 6px' }}>—</span>;
    return (
      <>
        <button type="button" className="btn btn-sm" disabled={busy === kind} onClick={() => inputs[kind].current?.click()}
          title={`Subir ${label} de esta compra`}
          style={{ padding: '1px 6px', fontSize: 10, border: '1px dashed var(--border)', background: 'transparent', color: 'var(--fg-3)' }}>
          {busy === kind ? '…' : `+ ${label}`}
        </button>
        <input ref={inputs[kind]} type="file" hidden accept={kind === 'pdf' ? 'application/pdf,.pdf' : 'application/json,.json'}
          onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void subir(kind, f); }} />
      </>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
      <div style={{ display: 'flex', gap: 4, whiteSpace: 'nowrap' }}>{boton('pdf')}{boton('json')}</div>
      {error && <span title={error} style={{ color: 'var(--danger-text)', fontSize: 10, maxWidth: 150, textAlign: 'right', whiteSpace: 'normal', lineHeight: 1.2 }}>{error}</span>}
    </div>
  );
}
