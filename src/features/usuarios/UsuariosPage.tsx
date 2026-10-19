import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner, Loading } from '@/components/ui/Feedback';
import { usePermissions } from '@/auth/usePermissions';
import { useAuth } from '@/auth/useAuth';

interface UserRow {
  id: string; email: string; full_name: string | null; role: string; active: boolean;
  created_at: string; last_login_at: string | null;
}
interface RoleDef { role: string; label: string; permissions: string[] }

type Editing = { mode: 'new' } | { mode: 'edit'; user: UserRow } | { mode: 'password'; user: UserRow } | null;

/**
 * Usuarios de la empresa: el administrador da de alta a su contador,
 * auxiliares, RRHH y cajeros, y define qué puede hacer cada uno.
 */
export function UsuariosPage() {
  const { can } = usePermissions();
  const me = useAuth().user;
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<{ items: UserRow[] }>('/v2/users'), enabled: can('users:manage') });
  const roles = useQuery({ queryKey: ['users', 'roles'], queryFn: () => api.get<{ items: RoleDef[] }>('/v2/users/roles'), enabled: can('users:manage') });
  const [editing, setEditing] = useState<Editing>(null);
  const [form, setForm] = useState({ email: '', full_name: '', role: 'contador', password: '' });

  const save = useMutation({
    mutationFn: async () => {
      if (editing?.mode === 'new') return api.post('/v2/users', form);
      if (editing?.mode === 'edit') return api.put(`/v2/users/${editing.user.id}`, { full_name: form.full_name, role: form.role });
      if (editing?.mode === 'password') return api.post(`/v2/users/${editing.user.id}/password`, { password: form.password });
    },
    onSuccess: () => { setEditing(null); void qc.invalidateQueries({ queryKey: ['users'] }); },
  });
  const toggle = useMutation({
    mutationFn: (u: UserRow) => api.put(`/v2/users/${u.id}`, { active: !u.active }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['users'] }),
  });

  if (!can('users:manage')) {
    return <EmptyState title="Acceso restringido" description="Solo el administrador de la empresa gestiona usuarios." />;
  }

  const roleLabel = (r: string) => roles.data?.items.find(x => x.role === r)?.label ?? r;
  const open = (e: Editing) => {
    save.reset();
    if (e?.mode === 'new') setForm({ email: '', full_name: '', role: 'contador', password: '' });
    else if (e) setForm({ email: e.user.email, full_name: e.user.full_name ?? '', role: e.user.role, password: '' });
    setEditing(e);
  };

  return (
    <div>
      <SectionHeader
        title="Usuarios"
        description="Cada empresa administra sus usuarios. El rol define qué módulos ve y qué puede registrar."
        actions={<Button onClick={() => open({ mode: 'new' })}>+ Nuevo usuario</Button>}
      />
      <ErrorBanner error={users.error ?? toggle.error} />
      {users.isLoading ? <Loading /> : (
        <div className="table-wrap"><div className="table-scroll">
          <table>
            <thead><tr><th>Nombre</th><th>Email</th><th>Rol</th><th>Estado</th><th>Último acceso</th><th /></tr></thead>
            <tbody>
              {(users.data?.items ?? []).map(u => (
                <tr key={u.id}>
                  <td>{u.full_name ?? '—'}</td>
                  <td className="muted">{u.email}</td>
                  <td>{roleLabel(u.role)}</td>
                  <td>{u.active ? <Badge tone="success">Activo</Badge> : <Badge tone="neutral">Inactivo</Badge>}</td>
                  <td className="muted">{u.last_login_at ? new Date(u.last_login_at).toLocaleString('es-SV') : 'Nunca'}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <Button size="sm" variant="secondary" onClick={() => open({ mode: 'edit', user: u })}>Editar</Button>{' '}
                    <Button size="sm" variant="secondary" onClick={() => open({ mode: 'password', user: u })}>Contraseña</Button>{' '}
                    {u.id !== me?.id && (
                      <Button size="sm" variant={u.active ? 'danger' : 'secondary'} onClick={() => toggle.mutate(u)}>
                        {u.active ? 'Desactivar' : 'Activar'}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div></div>
      )}

      {roles.data && (
        <div style={{ marginTop: 'var(--s-6)' }}>
          <div className="section-title" style={{ fontSize: 'var(--text-md)', marginBottom: 'var(--s-3)' }}>Roles disponibles</div>
          <div className="contrib-grid">
            {roles.data.items.map(r => (
              <div key={r.role} className="contrib-card">
                <div className="contrib-name">{r.label}</div>
                <div className="contrib-field" style={{ flexWrap: 'wrap' }}>
                  {r.permissions.length ? r.permissions.map(p => PERM_LABEL[p] ?? p).filter((v, i, a) => a.indexOf(v) === i).join(' · ') : 'Facturación y ventas'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {editing && (
        <Modal
          title={editing.mode === 'new' ? 'Nuevo usuario' : editing.mode === 'edit' ? 'Editar usuario' : `Nueva contraseña — ${editing.user.email}`}
          onClose={() => setEditing(null)}
          onSave={() => save.mutate()}
          saveDisabled={save.isPending}
        >
          <ErrorBanner error={save.error} />
          {editing.mode !== 'password' && (
            <>
              <Field label="Nombre completo"><Input value={form.full_name} onChange={e => setForm({ ...form, full_name: e.target.value })} /></Field>
              {editing.mode === 'new' && (
                <Field label="Email (usuario de acceso)"><Input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></Field>
              )}
              <Field label="Rol">
                <Select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>
                  {(roles.data?.items ?? []).map(r => <option key={r.role} value={r.role}>{r.label}</option>)}
                </Select>
              </Field>
            </>
          )}
          {editing.mode !== 'edit' && (
            <Field label="Contraseña (mínimo 8 caracteres)">
              <Input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />
            </Field>
          )}
        </Modal>
      )}
    </div>
  );
}

const PERM_LABEL: Record<string, string> = {
  'users:manage': 'Usuarios',
  'accounting:view': 'Contabilidad (consulta)', 'accounting:post': 'Partidas', 'accounting:review': 'Revisión',
  'accounting:config': 'Catálogo y configuración', 'accounting:close': 'Cierres',
  'receivables:view': 'CxC', 'receivables:manage': 'Cobros',
  'payables:view': 'CxP', 'payables:manage': 'Pagos',
  'banks:view': 'Bancos', 'banks:manage': 'Conciliación',
  'payroll:view': 'Planillas', 'payroll:manage': 'Emitir planillas', 'payroll:terminate': 'Liquidaciones',
  'fiscal:view': 'Posición fiscal', 'fiscal:manage': 'Pagos de impuestos',
  'assets:view': 'Activos fijos', 'assets:manage': 'Depreciación',
};
