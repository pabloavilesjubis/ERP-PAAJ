import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { ErrorBanner, Loading } from '@/components/ui/Feedback';
import { usePermissions } from '@/auth/usePermissions';
import { accApi } from '../api';
import { accKeys, useAccounts } from '../hooks';
import { AccountSelect } from '../components/AccountSelect';
import type { RoleAssignment } from '../types';
import { closingApi, type Signatories } from '../api';
import { Field, Input } from '@/components/ui/Field';

/**
 * Reglas de contabilización: qué cuenta del catálogo de ESTA empresa usa el
 * sistema para cada función (IVA débito, clientes, proveedores, banco…). Así
 * ningún código de cuenta queda fijo en el programa.
 */
export function ConfigContablePage() {
  const { can } = usePermissions();
  const qc = useQueryClient();
  const accounts = useAccounts();
  const roles = useQuery({ queryKey: accKeys.roles, queryFn: accApi.roles });
  const [draft, setDraft] = useState<Record<string, number | null>>({});
  useEffect(() => {
    if (roles.data) setDraft(Object.fromEntries(roles.data.map(r => [r.role_key, r.account_id])));
  }, [roles.data]);
  const save = useMutation({
    mutationFn: () => accApi.saveRoles(draft),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['acc'] }); },
  });

  const groups = useMemo(() => {
    const m = new Map<string, RoleAssignment[]>();
    for (const r of roles.data ?? []) {
      if (!m.has(r.group_name)) m.set(r.group_name, []);
      m.get(r.group_name)!.push(r);
    }
    return [...m.entries()];
  }, [roles.data]);

  if (roles.isLoading || accounts.isLoading) return <Loading />;
  const dirty = (roles.data ?? []).some(r => (draft[r.role_key] ?? null) !== r.account_id);
  const editable = can('accounting:config');

  return (
    <div>
      <SectionHeader
        title="Configuración contable"
        description="Asigna una cuenta de movimiento de tu catálogo a cada función. Las ventas, compras, cobros, pagos y bancos se contabilizan con estas cuentas."
        actions={editable && <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>{save.isPending ? 'Guardando…' : 'Guardar cambios'}</Button>}
      />
      <ErrorBanner error={roles.error ?? save.error} />
      {save.isSuccess && !dirty && <div className="banner banner-success" style={{ marginBottom: 'var(--s-4)' }}>Configuración guardada.</div>}
      {(accounts.data ?? []).length === 0 && <div className="banner banner-warning" style={{ marginBottom: 'var(--s-4)' }}>Primero carga el catálogo de cuentas.</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
        {groups.map(([group, items]) => (
          <div key={group} className="tax-card">
            <div className="tax-card-title">{group}</div>
            <div className="role-grid">
              {items.map(r => (
                <RoleRow key={r.role_key} role={r} value={draft[r.role_key] ?? null} editable={editable}
                  onChange={id => setDraft(d => ({ ...d, [r.role_key]: id }))} accounts={accounts.data ?? []} />
              ))}
            </div>
          </div>
        ))}
        <SignatoriesCard editable={editable} />
      </div>
    </div>
  );
}

function SignatoriesCard({ editable }: { editable: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['acc', 'company'], queryFn: closingApi.company });
  const [form, setForm] = useState<Signatories | null>(null);
  useEffect(() => { if (q.data) setForm(q.data.signatories); }, [q.data]);
  const save = useMutation({ mutationFn: () => closingApi.saveSignatories(form!), onSuccess: () => void qc.invalidateQueries({ queryKey: ['acc', 'company'] }) });
  if (!form) return null;
  const f = (k: keyof Signatories) => ({ value: form[k] ?? '', disabled: !editable, onChange: (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value }) });
  return (
    <div className="tax-card">
      <div className="tax-card-title" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>Firmantes de los estados financieros</span>
        {editable && <Button onClick={() => save.mutate()} disabled={save.isPending}>Guardar firmantes</Button>}
      </div>
      <ErrorBanner error={save.error} />
      {save.isSuccess && <div className="banner banner-success" style={{ marginBottom: 12 }}>Firmantes guardados.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
        <Field label="Representante legal"><Input {...f('legal_rep_name')} /></Field>
        <Field label="Cargo del representante"><Input {...f('legal_rep_title')} /></Field>
        <Field label="Contador"><Input {...f('accountant_name')} /></Field>
        <Field label="Inscripción del contador (CVPCPA)"><Input {...f('accountant_license')} /></Field>
        <Field label="Auditor externo"><Input {...f('auditor_name')} /></Field>
        <Field label="Inscripción del auditor"><Input {...f('auditor_license')} /></Field>
      </div>
    </div>
  );
}

function RoleRow({ role, value, onChange, editable, accounts }: {
  role: RoleAssignment; value: number | null; onChange: (id: number | null) => void; editable: boolean;
  accounts: Parameters<typeof AccountSelect>[0]['accounts'];
}) {
  return (
    <>
      <div>
        <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }}>{role.label}</div>
        {role.description && <div className="muted" style={{ fontSize: 'var(--text-xs)' }}>{role.description}</div>}
      </div>
      <AccountSelect accounts={accounts} value={value} onChange={onChange} disabled={!editable} placeholder="Sin asignar" />
    </>
  );
}
