import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Papa from 'papaparse';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner, Loading } from '@/components/ui/Feedback';
import { usePermissions } from '@/auth/usePermissions';
import { accApi } from '../api';
import { accKeys } from '../hooks';
import { currentMonth, todayIso } from '../dates';
import { dmy, entryNo, money, MODULE_LABEL, num } from '../format';
import { DateRange, type Range } from '../components/DateRange';
import { EntryModal, ManualEntryModal, StatusBadge } from '../components/EntryModals';
import { SetupBanner } from '../components/SetupBanner';

const PAGE = 100;

/** Asientos de la empresa: automáticos (de ventas, compras, bancos…) y partidas manuales. */
export function AsientosPage() {
  const { can } = usePermissions();
  const [range, setRange] = useState<Range>(currentMonth());
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [opening, setOpening] = useState(false);
  const params = { ...range, status, type, q: search, limit: PAGE, offset: page * PAGE };
  const q = useQuery({ queryKey: accKeys.entries(params), queryFn: () => accApi.entries(params), placeholderData: prev => prev });

  const items = q.data?.items ?? [];
  const total = q.data?.total ?? 0;

  return (
    <div>
      <SetupBanner />
      <SectionHeader
        title="Asientos contables"
        description="Los automáticos nacen de las operaciones; las partidas manuales las registra el contador."
        actions={can('accounting:post') && <>
          <Button variant="secondary" onClick={() => setOpening(true)}>Saldos iniciales</Button>
          <Button onClick={() => setCreating(true)}>+ Partida manual</Button>
        </>}
      />
      <div className="toolbar">
        <DateRange value={range} onChange={r => { setRange(r); setPage(0); }} />
      </div>
      <div className="toolbar">
        <Select value={status} onChange={e => { setStatus(e.target.value); setPage(0); }} style={{ width: 180 }}>
          <option value="">Todos los estados</option>
          <option value="borrador">Borradores</option>
          <option value="sin_revisar">Sin revisar</option>
          <option value="revisado">Revisados</option>
          <option value="anulado">Anulados</option>
        </Select>
        <Select value={type} onChange={e => { setType(e.target.value); setPage(0); }} style={{ width: 180 }}>
          <option value="">Todos los tipos</option>
          <option value="automatico">Automáticos</option>
          <option value="manual">Manuales</option>
          <option value="reversion">Reversiones</option>
        </Select>
        <Input placeholder="Buscar concepto, referencia o número…" value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} style={{ maxWidth: 320 }} />
      </div>
      <ErrorBanner error={q.error} />
      {q.isLoading ? <Loading /> : items.length === 0 ? (
        <EmptyState title="Sin asientos en el rango" description="Cambia las fechas o registra una partida manual." />
      ) : (
        <div className="table-wrap"><div className="table-scroll">
          <table className="acc-table">
            <thead><tr><th>N.º</th><th>Fecha</th><th>Concepto</th><th>Origen</th><th>Estado</th><th className="num">Monto</th></tr></thead>
            <tbody>
              {items.map(e => (
                <tr key={e.id} className={`clickable${e.status === 'anulado' ? ' voided' : ''}`} onClick={() => setOpen(Number(e.id))}>
                  <td className="code">{entryNo(e.entry_number)}</td>
                  <td className="code">{dmy(e.entry_date)}</td>
                  <td>{e.concept}{e.source_ref && <span className="muted"> · {e.source_ref}</span>}</td>
                  <td className="muted">{e.entry_type === 'reversion' ? 'Reversión' : MODULE_LABEL[e.source_module ?? ''] ?? e.source_module}</td>
                  <td><StatusBadge status={e.status} /></td>
                  <td className="num">{money(num(e.total_debit))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="table-footer">
          <span className="total-item">{total} asiento(s)</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Anterior</Button>
            <Button size="sm" variant="secondary" disabled={(page + 1) * PAGE >= total} onClick={() => setPage(p => p + 1)}>Siguiente</Button>
          </div>
        </div>
        </div>
      )}
      {open !== null && <EntryModal id={open} onClose={() => setOpen(null)} />}
      {creating && <ManualEntryModal onClose={() => setCreating(false)} />}
      {opening && <OpeningModal onClose={() => setOpening(false)} onCreated={id => { setOpening(false); setOpen(id); }} />}
    </div>
  );
}

/** Saldos iniciales: CSV (codigo, debe, haber) → partida de apertura en borrador. */
function OpeningModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const qc = useQueryClient();
  const [date, setDate] = useState(todayIso().slice(0, 8) + '01');
  const [rows, setRows] = useState<Array<{ code: string; debit: number; credit: number; description?: string }>>([]);
  const [err, setErr] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: () => accApi.importOpening(date, rows),
    onSuccess: r => { void qc.invalidateQueries({ queryKey: ['acc'] }); onCreated(r.id); },
  });
  const td = rows.reduce((s, r) => s + r.debit, 0);
  const tc = rows.reduce((s, r) => s + r.credit, 0);

  async function onFile(f: File | undefined) {
    if (!f) return;
    setErr(null);
    const text = await f.text();
    const res = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ''), { header: true, skipEmptyLines: 'greedy',
      transformHeader: h => h.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '') });
    const parsed = res.data.map(r => ({
      code: (r.codigo ?? r.cuenta ?? r.code ?? '').trim(),
      debit: num((r.debe ?? r.debit ?? '').replace(/,/g, '')),
      credit: num((r.haber ?? r.credit ?? '').replace(/,/g, '')),
      description: r.descripcion || undefined,
    })).filter(r => r.code && (r.debit || r.credit));
    if (!parsed.length) setErr('No se encontraron filas con columnas codigo, debe, haber.');
    setRows(parsed);
  }

  return (
    <Modal title="Saldos iniciales (partida de apertura)" onClose={onClose} size="wide"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => run.mutate()} disabled={!rows.length || run.isPending}>Crear partida en borrador</Button>
      </>}
    >
      <div className="banner banner-info">
        Sube un CSV con columnas <strong>codigo, debe, haber</strong> (opcional: descripcion) con los saldos de cada cuenta de
        movimiento a la fecha de inicio. Se crea una partida de apertura en borrador para que la revises y contabilices.
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
        <Field label="Fecha de apertura"><Input type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
        <input type="file" accept=".csv,text/csv" onChange={e => void onFile(e.target.files?.[0])} />
      </div>
      {err && <div className="banner banner-danger">{err}</div>}
      <ErrorBanner error={run.error} />
      {rows.length > 0 && <div className="stat-row">
        <span>{rows.length} cuentas</span><span>Debe <strong>{money(td)}</strong></span><span>Haber <strong>{money(tc)}</strong></span>
        {Math.abs(td - tc) > 0.004 && <span style={{ color: 'var(--danger-text)' }}>Descuadre {money(td - tc)} (podrás ajustarlo en el borrador)</span>}
      </div>}
    </Modal>
  );
}
