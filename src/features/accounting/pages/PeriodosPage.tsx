import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { Badge } from '@/components/ui/Badge';
import { ErrorBanner, Loading } from '@/components/ui/Feedback';
import { usePermissions } from '@/auth/usePermissions';
import { accApi } from '../api';
import { accKeys } from '../hooks';
import { MONTHS_ES } from '../format';
import type { PeriodRow } from '../types';
import { YearClose } from '../components/YearClose';

/** Cierre mensual: un mes cerrado no admite registros con esa fecha (ni automáticos ni manuales). */
export function PeriodosPage() {
  const { can } = usePermissions();
  const qc = useQueryClient();
  const [year, setYear] = useState(new Date().getFullYear());
  const [action, setAction] = useState<{ kind: 'close' | 'reopen'; p: PeriodRow } | null>(null);
  const [notes, setNotes] = useState('');
  const q = useQuery({ queryKey: accKeys.periods(year), queryFn: () => accApi.periods(year) });
  const run = useMutation({
    mutationFn: () => action!.kind === 'close'
      ? accApi.closePeriod(year, action!.p.month, notes || undefined)
      : accApi.reopenPeriod(year, action!.p.month, notes),
    onSuccess: () => { setAction(null); setNotes(''); void qc.invalidateQueries({ queryKey: ['acc'] }); },
  });

  return (
    <div>
      <SectionHeader
        title="Períodos contables"
        description="Cierra cada mes cuando esté revisado: nadie podrá registrar ni anular movimientos con fecha de un mes cerrado."
        actions={<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button variant="secondary" onClick={() => setYear(y => y - 1)}>‹</Button>
          <strong style={{ minWidth: 60, textAlign: 'center' }}>{year}</strong>
          <Button variant="secondary" onClick={() => setYear(y => y + 1)}>›</Button>
        </div>}
      />
      <ErrorBanner error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="period-grid">
          {(q.data?.items ?? []).map(p => (
            <div key={p.month} className={`period-card${p.status === 'cerrado' ? ' closed' : ''}`}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>{MONTHS_ES[p.month - 1]}</strong>
                {p.status === 'cerrado' ? <Badge tone="neutral">Cerrado</Badge> : <Badge tone="success">Abierto</Badge>}
              </div>
              <div className="muted" style={{ fontSize: 'var(--text-xs)' }}>
                {p.entries} asiento(s){p.drafts ? ` · ${p.drafts} borrador(es)` : ''}
              </div>
              {p.status === 'cerrado' && p.closed_by && <div className="muted" style={{ fontSize: 'var(--text-xs)' }}>Cerrado por {p.closed_by} · {new Date(p.closed_at!).toLocaleDateString('es-SV')}</div>}
              {p.status === 'abierto' && p.reopened_by && <div className="muted" style={{ fontSize: 'var(--text-xs)' }}>Reabierto por {p.reopened_by}: {p.notes}</div>}
              {can('accounting:close') && (
                p.status === 'cerrado'
                  ? <Button size="sm" variant="secondary" onClick={() => { setNotes(''); setAction({ kind: 'reopen', p }); }}>Reabrir</Button>
                  : <Button size="sm" onClick={() => { setNotes(''); setAction({ kind: 'close', p }); }}>Cerrar mes</Button>
              )}
            </div>
          ))}
        </div>
      )}
      <YearClose />
      {action && (
        <Modal
          title={`${action.kind === 'close' ? 'Cerrar' : 'Reabrir'} ${MONTHS_ES[action.p.month - 1]} ${year}`}
          onClose={() => setAction(null)}
          onSave={() => run.mutate()}
          saveLabel={action.kind === 'close' ? 'Cerrar período' : 'Reabrir período'}
          saveDisabled={run.isPending || (action.kind === 'reopen' && notes.trim().length < 3)}
        >
          <ErrorBanner error={run.error} />
          {action.kind === 'close'
            ? <div className="banner banner-info">Revisa la balanza del mes antes de cerrarlo. Los borradores del mes deben contabilizarse o eliminarse.</div>
            : <div className="banner banner-warning">Reabrir un mes permite modificar cifras ya reportadas. Queda registrado quién lo reabrió y por qué.</div>}
          <Field label={action.kind === 'close' ? 'Nota (opcional)' : 'Motivo de la reapertura'}>
            <Input value={notes} onChange={e => setNotes(e.target.value)} autoFocus />
          </Field>
        </Modal>
      )}
    </div>
  );
}
