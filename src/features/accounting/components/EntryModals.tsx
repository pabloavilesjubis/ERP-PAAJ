import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { ErrorBanner, Loading } from '@/components/ui/Feedback';
import { usePermissions } from '@/auth/usePermissions';
import { accApi, type ManualEntryInput } from '../api';
import { accKeys, useAccounts } from '../hooks';
import { dmy, entryNo, KIND_LABEL, money, money2, MODULE_LABEL, num, STATUS_LABEL } from '../format';
import { todayIso } from '../dates';
import { AccountSelect } from './AccountSelect';
import type { EntryStatus } from '../types';

export function StatusBadge({ status }: { status: EntryStatus }) {
  const tone = status === 'anulado' ? 'neutral' : status === 'borrador' ? 'warning' : status === 'revisado' ? 'success' : 'info';
  return <Badge tone={tone}>{STATUS_LABEL[status] ?? status}</Badge>;
}

/** Detalle de un asiento: líneas, trazabilidad y acciones (revisar, anular, editar borrador). */
export function EntryModal({ id, onClose }: { id: number; onClose: () => void }) {
  const qc = useQueryClient();
  const { can } = usePermissions();
  const [current, setCurrent] = useState(id);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const [editDraft, setEditDraft] = useState(false);
  const q = useQuery({ queryKey: accKeys.entry(current), queryFn: () => accApi.entry(current) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['acc'] }); };
  const review = useMutation({ mutationFn: () => accApi.review(current), onSuccess: refresh });
  const post = useMutation({ mutationFn: () => accApi.postEntry(current), onSuccess: refresh });
  const del = useMutation({ mutationFn: () => accApi.deleteDraft(current), onSuccess: () => { refresh(); onClose(); } });
  const voidM = useMutation({ mutationFn: () => accApi.voidEntry(current, reason), onSuccess: () => { setVoiding(false); refresh(); } });

  if (editDraft && q.data) {
    return <ManualEntryModal draft={q.data} onClose={() => { setEditDraft(false); refresh(); }} />;
  }

  const e = q.data?.entry;
  const lines = q.data?.lines ?? [];
  const td = lines.reduce((s, l) => s + num(l.debit), 0);
  const tc = lines.reduce((s, l) => s + num(l.credit), 0);

  return (
    <Modal title={e ? (e.entry_number ? `Asiento #${entryNo(e.entry_number)}` : 'Partida en borrador') : 'Asiento'} onClose={onClose} size="wide"
      footer={e && <>
        {e.status === 'borrador' && can('accounting:post') && <>
          <Button variant="danger" onClick={() => del.mutate()} disabled={del.isPending} style={{ marginRight: 'auto' }}>Eliminar borrador</Button>
          <Button variant="secondary" onClick={() => setEditDraft(true)}>Editar</Button>
          <Button onClick={() => post.mutate()} disabled={post.isPending}>Contabilizar</Button>
        </>}
        {e.status === 'contabilizado' && can('accounting:review') && <Button variant="secondary" onClick={() => review.mutate()} disabled={review.isPending}>Marcar revisado</Button>}
        {e.entry_type === 'manual' && (e.status === 'contabilizado' || e.status === 'revisado') && can('accounting:post') &&
          <Button variant="danger" onClick={() => setVoiding(true)}>Anular</Button>}
        <Button variant="secondary" onClick={onClose}>Cerrar</Button>
      </>}
    >
      <ErrorBanner error={q.error ?? review.error ?? post.error ?? del.error ?? voidM.error} />
      {!e ? <Loading /> : <>
        <div className="stat-row">
          <span>Fecha <strong>{dmy(e.entry_date)}</strong></span>
          <span>Estado <StatusBadge status={e.status} /></span>
          <span>Tipo <strong>{e.entry_type === 'manual' ? `Manual · ${KIND_LABEL[e.manual_kind ?? ''] ?? ''}` : e.entry_type === 'reversion' ? 'Reversión' : 'Automático'}</strong></span>
          {e.source_module && e.source_module !== 'manual' && <span>Origen <strong>{MODULE_LABEL[e.source_module] ?? e.source_module}</strong>{e.source_ref ? ` · ${e.source_ref}` : ''}</span>}
        </div>
        <div style={{ fontSize: 'var(--text-md)', fontWeight: 600 }}>{e.concept}</div>
        {e.notes && <div className="muted" style={{ fontSize: 'var(--text-sm)' }}>{e.notes}</div>}
        {e.reversed_by && <div className="banner banner-warning">
          Anulado por {e.voided_by_name ?? '—'}: {e.void_reason}.{' '}
          <a href="#" onClick={ev => { ev.preventDefault(); setCurrent(e.reversed_by!); }}>Ver reversión #{entryNo(e.reversed_by_number)}</a>
        </div>}
        {e.reversal_of && <div className="banner banner-info">
          Reversión del <a href="#" onClick={ev => { ev.preventDefault(); setCurrent(e.reversal_of!); }}>asiento #{entryNo(e.reversal_of_number)}</a>
        </div>}
        <div className="table-wrap"><div className="table-scroll">
          <table className="acc-table">
            <thead><tr><th>Cuenta</th><th>Descripción</th><th>Tercero</th><th className="num">Debe</th><th className="num">Haber</th></tr></thead>
            <tbody>
              {lines.map(l => (
                <tr key={l.id ?? l.line_no}>
                  <td><span className="combo-code">{l.account_code}</span> {l.account_name}</td>
                  <td className="muted">{l.description}</td>
                  <td className="muted">{l.party_name}</td>
                  <td className="num">{money(l.debit, { blankZero: true })}</td>
                  <td className="num">{money(l.credit, { blankZero: true })}</td>
                </tr>
              ))}
              <tr className="total"><td colSpan={3}>Totales</td><td className="num">{money(td)}</td><td className="num">{money(tc)}</td></tr>
            </tbody>
          </table>
        </div></div>
        <div className="muted" style={{ fontSize: 'var(--text-xs)' }}>
          Registrado por {e.created_by_name ?? '—'} · {new Date(e.created_at).toLocaleString('es-SV')}
          {e.reviewed_at && <> · Revisado por {e.reviewed_by_name} · {new Date(e.reviewed_at).toLocaleString('es-SV')}</>}
        </div>
        {voiding && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <Field label="Motivo de la anulación"><Input value={reason} onChange={ev => setReason(ev.target.value)} autoFocus /></Field>
            <Button variant="danger" onClick={() => voidM.mutate()} disabled={reason.trim().length < 3 || voidM.isPending}>Confirmar anulación</Button>
          </div>
        )}
      </>}
    </Modal>
  );
}

interface DraftLine { key: number; account_id: number | null; description: string; debit: string; credit: string }
let lineKey = 1;
const emptyLine = (): DraftLine => ({ key: lineKey++, account_id: null, description: '', debit: '', credit: '' });

/** Editor de partidas manuales (nueva o borrador existente). */
export function ManualEntryModal({ draft, onClose, kind = 'ajuste' }: {
  draft?: { entry: { id: number; entry_date: string; manual_kind: string | null; concept: string; notes: string | null }; lines: Array<{ account_id: number; description: string | null; debit: string | number; credit: string | number }> };
  onClose: () => void;
  kind?: string;
}) {
  const qc = useQueryClient();
  const accounts = useAccounts();
  const [date, setDate] = useState(draft?.entry.entry_date.slice(0, 10) ?? todayIso());
  const [manualKind, setManualKind] = useState(draft?.entry.manual_kind ?? kind);
  const [concept, setConcept] = useState(draft?.entry.concept ?? '');
  const [notes, setNotes] = useState(draft?.entry.notes ?? '');
  const [lines, setLines] = useState<DraftLine[]>(() => draft?.lines.length
    ? draft.lines.map(l => ({ key: lineKey++, account_id: Number(l.account_id), description: l.description ?? '',
        debit: num(l.debit) ? String(num(l.debit)) : '', credit: num(l.credit) ? String(num(l.credit)) : '' }))
    : [emptyLine(), emptyLine()]);

  const td = money2(lines.reduce((s, l) => s + num(l.debit), 0));
  const tc = money2(lines.reduce((s, l) => s + num(l.credit), 0));
  const diff = money2(td - tc);

  const save = useMutation({
    mutationFn: (postIt: boolean) => {
      const body: ManualEntryInput = {
        id: draft?.entry.id ?? null, entry_date: date, manual_kind: manualKind, concept, notes: notes || null, post: postIt,
        lines: lines.filter(l => l.account_id && (num(l.debit) || num(l.credit))).map(l => ({
          account_id: l.account_id!, debit: num(l.debit), credit: num(l.credit), description: l.description || null,
        })),
      };
      return accApi.saveManual(body);
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['acc'] }); onClose(); },
  });

  const update = (key: number, patch: Partial<DraftLine>) => setLines(ls => ls.map(l => (l.key === key ? { ...l, ...patch } : l)));
  const balanceLast = (key: number) => {
    // Completa la línea con la diferencia para cuadrar
    const others = lines.filter(l => l.key !== key);
    const d = money2(others.reduce((s, l) => s + num(l.debit), 0) - others.reduce((s, l) => s + num(l.credit), 0));
    update(key, d > 0 ? { credit: String(d), debit: '' } : { debit: String(-d), credit: '' });
  };

  return (
    <Modal title={draft ? 'Editar partida (borrador)' : 'Nueva partida contable'} onClose={onClose} size="xwide"
      footer={<>
        <span style={{ marginRight: 'auto', fontSize: 'var(--text-sm)', color: diff === 0 && td > 0 ? 'var(--success-text)' : 'var(--danger-text)' }}>
          {diff === 0 && td > 0 ? 'Partida cuadrada' : `Diferencia: ${money(diff)}`}
        </span>
        <Button variant="secondary" onClick={onClose}>Cancelar</Button>
        <Button variant="secondary" onClick={() => save.mutate(false)} disabled={save.isPending || !concept.trim()}>Guardar borrador</Button>
        <Button onClick={() => save.mutate(true)} disabled={save.isPending || diff !== 0 || td === 0 || !concept.trim()}>Contabilizar</Button>
      </>}
    >
      <ErrorBanner error={save.error} />
      <div style={{ display: 'grid', gridTemplateColumns: '170px 200px 1fr', gap: 12 }}>
        <Field label="Fecha"><Input type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
        <Field label="Tipo de partida">
          <Select value={manualKind} onChange={e => setManualKind(e.target.value)}>
            {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="Concepto"><Input value={concept} onChange={e => setConcept(e.target.value)} placeholder="Ej. Provisión de servicios básicos de marzo" autoFocus /></Field>
      </div>
      <div className="table-wrap" style={{ overflow: 'visible' }}>
        <table className="acc-table lines-editor">
          <thead><tr><th style={{ width: '38%' }}>Cuenta</th><th>Descripción</th><th className="num" style={{ width: 130 }}>Debe</th><th className="num" style={{ width: 130 }}>Haber</th><th style={{ width: 70 }} /></tr></thead>
          <tbody>
            {lines.map(l => (
              <tr key={l.key}>
                <td><AccountSelect accounts={accounts.data ?? []} value={l.account_id} onChange={id => update(l.key, { account_id: id })} /></td>
                <td><Input value={l.description} onChange={e => update(l.key, { description: e.target.value })} /></td>
                <td><Input inputMode="decimal" style={{ textAlign: 'right' }} value={l.debit} onChange={e => update(l.key, { debit: e.target.value, credit: e.target.value ? '' : l.credit })} /></td>
                <td><Input inputMode="decimal" style={{ textAlign: 'right' }} value={l.credit} onChange={e => update(l.key, { credit: e.target.value, debit: e.target.value ? '' : l.debit })} /></td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button type="button" className="btn-icon" title="Cuadrar con esta línea" onClick={() => balanceLast(l.key)}>=</button>{' '}
                  <button type="button" className="btn-icon" title="Quitar línea" onClick={() => setLines(ls => ls.length > 1 ? ls.filter(x => x.key !== l.key) : ls)}>×</button>
                </td>
              </tr>
            ))}
            <tr className="total">
              <td colSpan={2}><Button size="sm" variant="secondary" onClick={() => setLines(ls => [...ls, emptyLine()])}>+ Línea</Button></td>
              <td className="num">{money(td)}</td><td className="num">{money(tc)}</td><td />
            </tr>
          </tbody>
        </table>
      </div>
      <Field label="Notas (opcional)"><Input value={notes} onChange={e => setNotes(e.target.value)} /></Field>
    </Modal>
  );
}
