import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { Badge } from '@/components/ui/Badge';
import { ErrorBanner, Loading } from '@/components/ui/Feedback';
import { usePermissions } from '@/auth/usePermissions';
import { accApi, type AccountInput, type ImportRow } from '../api';
import { accKeys, byCode, useAccounts } from '../hooks';
import { CATALOG_TEMPLATE, catalogToCsv, downloadText, parseCatalogCsv } from '../catalogCsv';
import type { Account, AccountType } from '../types';

const TYPES: AccountType[] = ['Activo', 'Contraactivo', 'Pasivo', 'Patrimonio', 'Ingreso', 'Costo', 'Gasto', 'Resultado'];

type Editing = { mode: 'new'; parent: Account | null } | { mode: 'edit'; account: Account } | null;

/**
 * Catálogo de cuentas de la empresa. Cada empresa carga el suyo (CSV) y lo
 * mantiene aquí: cuentas de mayor agrupan, solo las de movimiento reciben
 * asientos.
 */
export function CatalogoPage() {
  const { can } = usePermissions();
  const canEdit = can('accounting:config');
  const navigate = useNavigate();
  const accounts = useAccounts();
  const [filter, setFilter] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<Editing>(null);
  const [importing, setImporting] = useState(false);

  const list = useMemo(() => [...(accounts.data ?? [])].sort(byCode), [accounts.data]);
  const byId = useMemo(() => new Map(list.map(a => [a.id, a])), [list]);
  const hasChildren = useMemo(() => new Set(list.map(a => a.parent_id).filter((x): x is number => x !== null)), [list]);

  const visible = useMemo(() => {
    const t = filter.trim().toLowerCase();
    if (t) return list.filter(a => (showInactive || a.is_active) && (a.code.startsWith(t) || a.name.toLowerCase().includes(t)));
    return list.filter(a => {
      if (!showInactive && !a.is_active) return false;
      for (let p = a.parent_id ? byId.get(a.parent_id) : undefined; p; p = p.parent_id ? byId.get(p.parent_id) : undefined) {
        if (collapsed.has(p.id)) return false;
      }
      return true;
    });
  }, [list, byId, filter, showInactive, collapsed]);

  if (accounts.isLoading) return <Loading />;

  const toggle = (id: number) => setCollapsed(prev => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  return (
    <div>
      <SectionHeader
        title="Catálogo de cuentas"
        description={`${list.length} cuentas · ${list.filter(a => a.allows_movements).length} de movimiento`}
        actions={<>
          {list.length > 0 && <Button variant="secondary" onClick={() => downloadText('catalogo-de-cuentas.csv', catalogToCsv(list))}>Exportar CSV</Button>}
          {canEdit && <Button variant="secondary" onClick={() => setImporting(true)}>Importar CSV</Button>}
          {canEdit && <Button onClick={() => setEditing({ mode: 'new', parent: null })}>+ Cuenta</Button>}
        </>}
      />
      <ErrorBanner error={accounts.error} />

      {list.length === 0 ? (
        <div className="table-wrap" style={{ padding: 'var(--s-6)' }}>
          <EmptyState title="Esta empresa aún no tiene catálogo de cuentas"
            description="Importa el catálogo de tu contador en CSV (código, nombre, tipo de cuenta). Puedes descargar la plantilla como punto de partida." />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <Button variant="secondary" onClick={() => downloadText('plantilla-catalogo.csv', CATALOG_TEMPLATE)}>Descargar plantilla</Button>
            {canEdit && <Button onClick={() => setImporting(true)}>Importar catálogo</Button>}
          </div>
        </div>
      ) : (
        <>
          <div className="toolbar">
            <Input placeholder="Buscar por código o nombre…" value={filter} onChange={e => setFilter(e.target.value)} style={{ maxWidth: 320 }} />
            <label style={{ fontSize: 'var(--text-sm)', display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} /> Mostrar inactivas
            </label>
            <Button size="sm" variant="secondary" onClick={() => setCollapsed(new Set(list.filter(a => a.level === 1).map(a => a.id)))}>Contraer</Button>
            <Button size="sm" variant="secondary" onClick={() => setCollapsed(new Set())}>Expandir</Button>
          </div>
          <div className="table-wrap"><div className="table-scroll">
            <table className="acc-table">
              <thead><tr><th>Código</th><th>Nombre</th><th>Tipo</th><th>Naturaleza</th><th>Uso</th><th>Clasificación</th><th /></tr></thead>
              <tbody>
                {visible.map(a => (
                  <tr key={a.id} className={`${a.allows_movements ? '' : 'major'}${a.is_active ? '' : ' muted'}`}>
                    <td className="code" style={{ paddingLeft: 10 + (filter ? 0 : (a.level - 1) * 16) }}>
                      {hasChildren.has(a.id) && !filter ? (
                        <button type="button" onClick={() => toggle(a.id)} style={{ border: 'none', background: 'none', cursor: 'pointer', width: 16, color: 'var(--fg-3)' }}>
                          {collapsed.has(a.id) ? '▸' : '▾'}
                        </button>
                      ) : <span style={{ display: 'inline-block', width: 16 }} />}
                      {a.code}
                    </td>
                    <td>{a.name}{!a.is_active && <> <Badge>Inactiva</Badge></>}</td>
                    <td>{a.account_type}</td>
                    <td className="muted">{a.nature}</td>
                    <td className="muted">{a.allows_movements ? 'Movimiento' : 'Mayor'}</td>
                    <td className="muted">{a.balance_term === 'corriente' ? 'Corriente' : a.balance_term === 'no_corriente' ? 'No corriente' : ''}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <Button size="sm" variant="secondary" onClick={() => navigate(`/contabilidad/libros/mayor?account=${a.id}`)}>Mayor</Button>{' '}
                      {canEdit && !a.allows_movements && <><Button size="sm" variant="secondary" onClick={() => setEditing({ mode: 'new', parent: a })}>+ Sub</Button>{' '}</>}
                      {canEdit && <Button size="sm" variant="secondary" onClick={() => setEditing({ mode: 'edit', account: a })}>Editar</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div></div>
        </>
      )}

      {editing && <AccountForm editing={editing} accounts={list} onClose={() => setEditing(null)} />}
      {importing && <ImportModal hasAccounts={list.length > 0} onClose={() => setImporting(false)} />}
    </div>
  );
}

function suggestCode(parent: Account | null, accounts: Account[]): string {
  if (!parent) return '';
  const kids = accounts.filter(a => a.parent_id === parent.id).map(a => a.code).sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
  const last = kids[kids.length - 1];
  const dotted = parent.code.includes('.') || (last?.includes('.') ?? true);
  if (!last) return dotted ? `${parent.code}.01` : `${parent.code}01`;
  const tail = dotted ? last.slice(parent.code.length + 1) : last.slice(parent.code.length);
  const next = String(parseInt(tail, 10) + 1).padStart(tail.length, '0');
  return dotted ? `${parent.code}.${next}` : `${parent.code}${next}`;
}

function AccountForm({ editing, accounts, onClose }: { editing: NonNullable<Editing>; accounts: Account[]; onClose: () => void }) {
  const qc = useQueryClient();
  const base = editing.mode === 'edit' ? editing.account : null;
  const parent0 = editing.mode === 'new' ? editing.parent : (base?.parent_id ? accounts.find(a => a.id === base.parent_id) ?? null : null);
  const [form, setForm] = useState<AccountInput>({
    code: base?.code ?? suggestCode(parent0, accounts),
    name: base?.name ?? '',
    account_type: base?.account_type ?? parent0?.account_type ?? 'Activo',
    nature: base?.nature ?? parent0?.nature,
    parent_id: base ? base.parent_id : parent0?.id ?? null,
    balance_term: base?.balance_term ?? null,
    result_section: base?.result_section ?? null,
    allows_movements: base?.allows_movements ?? true,
    is_active: base?.is_active ?? true,
  });
  const save = useMutation({
    mutationFn: async (): Promise<unknown> => base ? accApi.updateAccount(base.id, form) : accApi.createAccount(form),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: accKeys.accounts }); onClose(); },
  });
  const remove = useMutation({
    mutationFn: () => accApi.deleteAccount(base!.id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: accKeys.accounts }); onClose(); },
  });
  const majors = accounts.filter(a => !a.allows_movements && a.id !== base?.id);
  const set = <K extends keyof AccountInput>(k: K, v: AccountInput[K]) => setForm(f => ({ ...f, [k]: v }));

  return (
    <Modal
      title={base ? `Editar cuenta ${base.code}` : parent0 ? `Nueva subcuenta de ${parent0.code} ${parent0.name}` : 'Nueva cuenta'}
      onClose={onClose}
      footer={<>
        {base && !base.has_movements && <Button variant="danger" onClick={() => remove.mutate()} disabled={remove.isPending} style={{ marginRight: 'auto' }}>Eliminar</Button>}
        <Button variant="secondary" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending}>Guardar</Button>
      </>}
    >
      <ErrorBanner error={save.error ?? remove.error} />
      <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12 }}>
        <Field label="Código"><Input value={form.code} onChange={e => set('code', e.target.value)} disabled={!!base?.has_movements} /></Field>
        <Field label="Nombre"><Input value={form.name} onChange={e => set('name', e.target.value)} autoFocus /></Field>
      </div>
      <Field label="Cuenta padre (de mayor)">
        <Select value={form.parent_id ?? ''} onChange={e => set('parent_id', e.target.value ? Number(e.target.value) : null)}>
          <option value="">— Sin padre (cuenta de primer nivel) —</option>
          {majors.map(a => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
        </Select>
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Tipo">
          <Select value={form.account_type} onChange={e => set('account_type', e.target.value)}>
            {TYPES.map(t => <option key={t}>{t}</option>)}
          </Select>
        </Field>
        <Field label="Naturaleza">
          <Select value={form.nature ?? ''} onChange={e => set('nature', e.target.value || undefined)}>
            <option value="">Según el tipo</option>
            <option>Deudora</option><option>Acreedora</option><option>Mixta</option>
          </Select>
        </Field>
        <Field label="Uso">
          <Select value={form.allows_movements ? 'mov' : 'mayor'} onChange={e => set('allows_movements', e.target.value === 'mov')}>
            <option value="mov">Movimiento (recibe asientos)</option>
            <option value="mayor">Mayor (agrupa subcuentas)</option>
          </Select>
        </Field>
        <Field label="Clasificación (balance)">
          <Select value={form.balance_term ?? ''} onChange={e => set('balance_term', e.target.value || null)}>
            <option value="">Hereda del grupo</option>
            <option value="corriente">Corriente</option>
            <option value="no_corriente">No corriente</option>
          </Select>
        </Field>
      </div>
      <label style={{ fontSize: 'var(--text-sm)', display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="checkbox" checked={form.is_active} onChange={e => set('is_active', e.target.checked)} /> Cuenta activa
      </label>
    </Modal>
  );
}

function ImportModal({ hasAccounts, onClose }: { hasAccounts: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [parsed, setParsed] = useState<{ rows: ImportRow[]; errors: string[]; name: string } | null>(null);
  const run = useMutation({
    mutationFn: () => accApi.importAccounts(parsed!.rows),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['acc'] }); },
  });

  async function onFile(f: File | undefined) {
    if (!f) return;
    const buf = await f.arrayBuffer();
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf);   // Excel en Windows
    setParsed({ ...parseCatalogCsv(text), name: f.name });
    run.reset();
  }

  return (
    <Modal title="Importar catálogo de cuentas" onClose={onClose} size="wide"
      footer={run.isSuccess
        ? <Button onClick={onClose}>Listo</Button>
        : <>
            <Button variant="secondary" onClick={onClose}>Cancelar</Button>
            <Button onClick={() => run.mutate()} disabled={!parsed?.rows.length || !!parsed.errors.length || run.isPending}>
              {run.isPending ? 'Importando…' : `Importar ${parsed?.rows.length ?? 0} cuentas`}
            </Button>
          </>}
    >
      <div className="banner banner-info">
        CSV con columnas <strong>codigo, nombre, tipo_cuenta</strong> (Activo, Contraactivo, Pasivo, Patrimonio, Ingreso, Costo, Gasto, Resultado).
        Opcionales: naturaleza, cuenta_padre, estado_financiero, permite_movimientos (SI/NO), activa, clasificacion (corriente / no_corriente).
        El padre se deduce del código si no viene. {hasAccounts && 'Las cuentas existentes con el mismo código se actualizan; ninguna se borra.'}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="file" accept=".csv,text/csv" onChange={e => void onFile(e.target.files?.[0])} />
        <Button size="sm" variant="secondary" onClick={() => downloadText('plantilla-catalogo.csv', CATALOG_TEMPLATE)}>Plantilla</Button>
      </div>
      <ErrorBanner error={run.error} />
      {run.isSuccess && <div className="banner banner-success">Catálogo importado: {run.data.inserted} cuentas nuevas, {run.data.updated} actualizadas.</div>}
      {parsed && parsed.errors.length > 0 && (
        <div className="banner banner-danger" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
          {parsed.errors.slice(0, 10).map(e => <div key={e}>{e}</div>)}
          {parsed.errors.length > 10 && <div>… y {parsed.errors.length - 10} más</div>}
        </div>
      )}
      {parsed && parsed.rows.length > 0 && !run.isSuccess && (
        <div className="table-wrap"><div className="table-scroll" style={{ maxHeight: 360 }}>
          <table className="acc-table">
            <thead><tr><th>Código</th><th>Nombre</th><th>Tipo</th><th>Padre</th><th>Uso</th></tr></thead>
            <tbody>
              {parsed.rows.slice(0, 200).map(r => (
                <tr key={r.code}>
                  <td className="code">{r.code}</td><td>{r.name}</td><td>{r.account_type}</td>
                  <td className="muted">{r.parent_code ?? 'auto'}</td>
                  <td className="muted">{r.allows_movements === null || r.allows_movements === undefined ? 'auto' : r.allows_movements ? 'Movimiento' : 'Mayor'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div></div>
      )}
      {parsed && parsed.rows.length > 200 && <div className="muted" style={{ fontSize: 'var(--text-xs)' }}>Vista previa de 200 de {parsed.rows.length} filas.</div>}
    </Modal>
  );
}
