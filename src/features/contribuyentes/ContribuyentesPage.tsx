import { useState } from 'react';
import { Icon } from '@/components/icons/Icon';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field, Input, Select } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { SectionHeader } from '@/components/ui/SectionHeader';
import {
  ACTIVIDADES_ECONOMICAS, DEPARTAMENTOS, findDepartamento, findMunicipio,
  getMunicipiosFor,
} from '@/lib/catalogos/mh';
import { newId } from '@/lib/utils/format';
import { useDataStore } from '@/stores/data.store';
import type { Contribuyente, ContribuyenteTipo } from '@/types/domain';

const empty: Omit<Contribuyente, 'id'> = {
  nombre: '', nit: '', dui: '', nrc: '', giro: '', telefono: '', email: '', direccion: '',
  departamento: '06', municipio: '14', codActividad: '',
  tipo: 'Cliente',
};

type Tab = 'all' | ContribuyenteTipo;

export function ContribuyentesPage() {
  const data = useDataStore(s => s.data);
  const setCollection = useDataStore(s => s.set);

  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...empty });
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<Tab>('all');

  const filtered = data.contribuyentes.filter(c => {
    const q = search.toLowerCase();
    const match = !q
      || c.nombre.toLowerCase().includes(q)
      || c.nrc.includes(search)
      || c.nit.includes(search)
      || (c.dui ?? '').includes(search);
    // "Ambos" es tanto Cliente como Proveedor: aparece en las dos pestañas (no
    // solo en "Ambos") porque conceptualmente cumple los dos roles.
    const typeMatch =
      tab === 'all'
      || c.tipo === tab
      || (c.tipo === 'Ambos' && (tab === 'Cliente' || tab === 'Proveedor'));
    return match && typeMatch;
  });

  function openNew() { setForm({ ...empty }); setEditId(null); setShowModal(true); }
  function openEdit(c: Contribuyente) { setForm({ ...c }); setEditId(c.id); setShowModal(true); }

  async function save() {
    if (!form.nombre || !form.nrc) return;
    const next = editId
      ? data.contribuyentes.map(c => c.id === editId ? { ...c, ...form } : c)
      : [...data.contribuyentes, { id: newId(), ...form }];
    await setCollection('contribuyentes', next);
    setShowModal(false);
  }
  async function del(id: string) {
    await setCollection('contribuyentes', data.contribuyentes.filter(c => c.id !== id));
  }

  return (
    <div>
      <SectionHeader
        title="Contribuyentes"
        description="Clientes y proveedores registrados"
        actions={
          <>
            <div style={{ position: 'relative' }}>
              <Icon name="search" size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--fg-4)' }} />
              <Input style={{ paddingLeft: 32, width: 220 }} placeholder="Buscar por nombre o NRC…" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <Button onClick={openNew} leading={<Icon name="plus" size={15} />}>Agregar</Button>
          </>
        }
      />

      <div className="tabs">
        {([['all', 'Todos'], ['Cliente', 'Clientes'], ['Proveedor', 'Proveedores'], ['Ambos', 'Ambos']] as const).map(([v, l]) => (
          <div key={v} className={`tab${tab === v ? ' active' : ''}`} onClick={() => setTab(v)}>{l}</div>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="table-wrap"><EmptyState title="Sin resultados" description="Intenta con otra búsqueda o agrega un contribuyente." /></div>
      ) : (
        <div className="contrib-grid">
          {filtered.map(c => (
            <div className="contrib-card" key={c.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--s-3)' }}>
                <div>
                  <div className="contrib-name">{c.nombre}</div>
                  <Badge tone={c.tipo === 'Cliente' ? 'info' : c.tipo === 'Proveedor' ? 'neutral' : 'warning'}>{c.tipo}</Badge>
                </div>
              </div>
              <div className="contrib-meta">
                <div className="contrib-field">NIT <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>{c.nit}</span></div>
                {c.dui && <div className="contrib-field">DUI <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>{c.dui}</span></div>}
                <div className="contrib-field">NRC <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>{c.nrc}</span></div>
                {(c.codActividad || c.giro) && (
                  <div className="contrib-field">
                    Actividad <span>
                      {c.codActividad && <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', marginRight: 4 }}>{c.codActividad}</code>}
                      {c.giro}
                    </span>
                  </div>
                )}
                {c.departamento && c.municipio && (
                  <div className="contrib-field">
                    Ubicación <span>
                      {findMunicipio(c.departamento, c.municipio)?.nombre ?? c.municipio},{' '}
                      {findDepartamento(c.departamento)?.nombre ?? c.departamento}
                    </span>
                  </div>
                )}
                {c.telefono && <div className="contrib-field">Tel <span>{c.telefono}</span></div>}
                {c.email && <div className="contrib-field">Email <span style={{ wordBreak: 'break-all' }}>{c.email}</span></div>}
                {c.direccion && <div className="contrib-field">Dir. <span>{c.direccion}</span></div>}
              </div>
              <div className="contrib-actions">
                <Button variant="secondary" size="sm" onClick={() => openEdit(c)} leading={<Icon name="edit" size={13} />}>Editar</Button>
                <Button variant="danger" size="sm" onClick={() => del(c.id)} leading={<Icon name="trash" size={13} />}>Eliminar</Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <Modal title={editId ? 'Editar contribuyente' : 'Nuevo contribuyente'} onClose={() => setShowModal(false)} onSave={save}>
          <div className="two-col">
            <Field label="Nombre / Razón social" fullWidth>
              <Input type="text" placeholder="Empresa o persona natural" value={form.nombre} onChange={e => setForm(p => ({ ...p, nombre: e.target.value }))} />
            </Field>
            <Field label="NIT"><Input type="text" placeholder="0614-000000-000-0" value={form.nit} onChange={e => setForm(p => ({ ...p, nit: e.target.value }))} /></Field>
            <Field label="NRC"><Input type="text" placeholder="123456-7" value={form.nrc} onChange={e => setForm(p => ({ ...p, nrc: e.target.value }))} /></Field>
            <Field label="DUI (opcional, persona natural)">
              <Input type="text" placeholder="01234567-8" value={form.dui ?? ''} onChange={e => setForm(p => ({ ...p, dui: e.target.value }))} />
            </Field>
            <Field label="Tipo">
              <Select value={form.tipo} onChange={e => setForm(p => ({ ...p, tipo: e.target.value as ContribuyenteTipo }))}>
                <option>Cliente</option><option>Proveedor</option><option>Ambos</option>
              </Select>
            </Field>
            <Field label="Actividad económica (CAT-019 del MH)" fullWidth>
              <Select
                value={form.codActividad ?? ''}
                onChange={e => {
                  const codigo = e.target.value;
                  const cat = ACTIVIDADES_ECONOMICAS.find(a => a.codigo === codigo);
                  setForm(p => ({
                    ...p,
                    codActividad: codigo,
                    giro: cat ? cat.nombre : (codigo === 'otro' ? (p.giro ?? '') : ''),
                  }));
                }}
              >
                <option value="">— Selecciona una actividad —</option>
                {ACTIVIDADES_ECONOMICAS.map(a => (
                  <option key={a.codigo} value={a.codigo}>{a.codigo} — {a.nombre}</option>
                ))}
                <option value="otro">Otra (ingresar manualmente)</option>
              </Select>
            </Field>
            {form.codActividad === 'otro' && (
              <>
                <Field label="Código actividad (2-6 dígitos)">
                  <Input
                    type="text"
                    placeholder="46900"
                    value={form.codActividad === 'otro' ? '' : (form.codActividad ?? '')}
                    onChange={e => setForm(p => ({ ...p, codActividad: e.target.value.replace(/\D/g, '').slice(0, 6) || 'otro' }))}
                  />
                </Field>
                <Field label="Descripción">
                  <Input type="text" placeholder="Mi actividad" value={form.giro ?? ''} onChange={e => setForm(p => ({ ...p, giro: e.target.value }))} />
                </Field>
              </>
            )}
            <Field label="Departamento (CAT-012)">
              <Select
                value={form.departamento ?? ''}
                onChange={e => {
                  const nuevoDept = e.target.value;
                  const munis = getMunicipiosFor(nuevoDept);
                  setForm(p => ({
                    ...p,
                    departamento: nuevoDept,
                    municipio: munis[0]?.codigo ?? '',
                  }));
                }}
              >
                <option value="">— Selecciona —</option>
                {DEPARTAMENTOS.map(d => (
                  <option key={d.codigo} value={d.codigo}>{d.codigo} — {d.nombre}</option>
                ))}
              </Select>
            </Field>
            <Field label="Municipio (CAT-013)">
              <Select
                value={form.municipio ?? ''}
                onChange={e => setForm(p => ({ ...p, municipio: e.target.value }))}
                disabled={!form.departamento}
              >
                <option value="">— Selecciona depto. primero —</option>
                {getMunicipiosFor(form.departamento ?? '').map(m => (
                  <option key={m.codigo} value={m.codigo}>{m.codigo} — {m.nombre}</option>
                ))}
              </Select>
            </Field>
            <Field label="Teléfono"><Input type="text" placeholder="2234-5678" value={form.telefono ?? ''} onChange={e => setForm(p => ({ ...p, telefono: e.target.value }))} /></Field>
            <Field label="Email"><Input type="email" placeholder="correo@empresa.com" value={form.email ?? ''} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} /></Field>
            <Field label="Dirección (calle, colonia, número)" fullWidth>
              <Input type="text" placeholder="Col. Escalón, Calle Los Almendros #15" value={form.direccion ?? ''} onChange={e => setForm(p => ({ ...p, direccion: e.target.value }))} />
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
