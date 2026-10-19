import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { ErrorBanner, Loading } from '@/components/ui/Feedback';
import { usePermissions } from '@/auth/usePermissions';
import { closingApi, type FiscalYear } from '../api';
import { entryNo, money } from '../format';
import { EntryModal } from './EntryModals';

/** Cierre del ejercicio: salda resultados contra la utilidad del ejercicio y cierra los 12 meses. */
export function YearClose() {
  const { can } = usePermissions();
  const q = useQuery({ queryKey: ['acc', 'fiscal-years'], queryFn: closingApi.years });
  const [closing, setClosing] = useState<number | null>(null);
  const [reopening, setReopening] = useState<FiscalYear | null>(null);
  const [entry, setEntry] = useState<number | null>(null);
  if (q.isLoading) return <Loading />;
  return (
    <div style={{ marginTop: 'var(--s-8)' }}>
      <div className="section-title" style={{ marginBottom: 'var(--s-2)' }}>Cierre del ejercicio</div>
      <div className="muted" style={{ fontSize: 'var(--text-sm)', marginBottom: 'var(--s-4)' }}>
        Registra la partida de cierre al 31 de diciembre (las cuentas de resultados quedan en cero contra «Utilidad del ejercicio»),
        opcionalmente traslada el resultado a utilidades acumuladas el 1 de enero, y cierra los doce meses.
      </div>
      <ErrorBanner error={q.error} />
      <div className="table-wrap"><table className="acc-table">
        <thead><tr><th>Ejercicio</th><th>Estado</th><th className="num">Resultado</th><th>Partidas</th><th>Detalle</th><th /></tr></thead>
        <tbody>
          {(q.data ?? []).map(y => (
            <tr key={y.year}>
              <td><strong>{y.year}</strong></td>
              <td>{y.status === 'cerrado' ? <Badge tone="neutral">Cerrado</Badge> : <Badge tone="success">Abierto</Badge>}</td>
              <td className="num">{y.result === null ? '' : money(y.result)}</td>
              <td>
                {y.closing_entry_id && <Button size="sm" variant="secondary" onClick={() => setEntry(y.closing_entry_id!)}>Cierre #{entryNo(y.closing_entry_number)}</Button>}{' '}
                {y.transfer_entry_id && <Button size="sm" variant="secondary" onClick={() => setEntry(y.transfer_entry_id!)}>Traslado #{entryNo(y.transfer_entry_number)}</Button>}
              </td>
              <td className="muted" style={{ fontSize: 'var(--text-xs)' }}>
                {y.status === 'cerrado' && y.closed_by ? `Cerrado por ${y.closed_by}` : y.reopened_by ? `Reabierto por ${y.reopened_by}: ${y.notes ?? ''}` : ''}
              </td>
              <td style={{ textAlign: 'right' }}>
                {can('accounting:close') && (y.status === 'cerrado'
                  ? <Button size="sm" variant="secondary" onClick={() => setReopening(y)}>Reabrir</Button>
                  : <Button size="sm" onClick={() => setClosing(y.year)}>Cerrar ejercicio</Button>)}
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {closing !== null && <CloseModal year={closing} onClose={() => setClosing(null)} />}
      {reopening && <ReopenModal year={reopening.year} onClose={() => setReopening(null)} />}
      {entry !== null && <EntryModal id={entry} onClose={() => setEntry(null)} />}
    </div>
  );
}

function CloseModal({ year, onClose }: { year: number; onClose: () => void }) {
  const qc = useQueryClient();
  const [transfer, setTransfer] = useState(true);
  const prev = useQuery({ queryKey: ['acc', 'year-preview', year], queryFn: () => closingApi.preview(year) });
  const run = useMutation({
    mutationFn: () => closingApi.close(year, transfer),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['acc'] }); onClose(); },
  });
  const issues = prev.data?.issues ?? [];
  return (
    <Modal title={`Cerrar el ejercicio ${year}`} onClose={onClose} onSave={() => run.mutate()} saveLabel="Cerrar ejercicio"
      saveDisabled={run.isPending || !prev.data || issues.length > 0}>
      <ErrorBanner error={prev.error ?? run.error} />
      {!prev.data ? <Loading /> : <>
        <div className="stat-row">
          <span>{prev.data.result >= 0 ? 'Utilidad' : 'Pérdida'} del ejercicio <strong>{money(Math.abs(prev.data.result))}</strong></span>
          <span>{prev.data.accounts} cuentas de resultados a saldar</span>
        </div>
        {issues.length > 0
          ? <div className="banner banner-warning" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
              <strong>Antes de cerrar:</strong>{issues.map(i => <div key={i}>• {i}</div>)}
            </div>
          : <div className="banner banner-info">Revisa los estados financieros del año antes de cerrar. Después nadie podrá registrar con fecha de {year} sin reabrirlo.</div>}
        <label style={{ fontSize: 'var(--text-sm)', display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={transfer} onChange={e => setTransfer(e.target.checked)} />
          Trasladar el resultado a utilidades acumuladas el 01/01/{year + 1}
        </label>
      </>}
    </Modal>
  );
}

function ReopenModal({ year, onClose }: { year: number; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const run = useMutation({
    mutationFn: () => closingApi.reopen(year, reason),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['acc'] }); onClose(); },
  });
  return (
    <Modal title={`Reabrir el ejercicio ${year}`} onClose={onClose} onSave={() => run.mutate()} saveLabel="Reabrir"
      saveDisabled={run.isPending || reason.trim().length < 3}>
      <ErrorBanner error={run.error} />
      <div className="banner banner-warning">Se revierten la partida de cierre y el traslado, y se reabre diciembre. Los demás meses siguen cerrados.</div>
      <Field label="Motivo"><Input value={reason} onChange={e => setReason(e.target.value)} autoFocus /></Field>
    </Modal>
  );
}
