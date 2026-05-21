import { useState } from 'react';
import { Icon } from '@/components/icons/Icon';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field, Input, Select } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { newId, num, fmt } from '@/lib/utils/format';
import { useDataStore } from '@/stores/data.store';
import type { Producto, ProductoTipo } from '@/types/domain';

interface FormState {
  codigo: string;
  nombre: string;
  descripcion: string;
  tipo: ProductoTipo;
  precioUnitario: string;
  uniMedida: string;
  codActividad: string;
  activo: boolean;
}

const emptyForm: FormState = {
  codigo: '',
  nombre: '',
  descripcion: '',
  tipo: 'servicio',
  precioUnitario: '',
  uniMedida: '59',
  codActividad: '',
  activo: true,
};

const TIPO_OPTIONS = [
  { value: 'servicio' as const, label: 'Servicio' },
  { value: 'bien' as const, label: 'Bien' },
];

// Subset de CAT-014 más usado. El usuario puede añadir más si los necesita.
const UNI_MEDIDA_OPTIONS = [
  { value: '59', label: '59 — Unidad' },
  { value: '1',  label: '1 — Metro' },
  { value: '17', label: '17 — Caja' },
  { value: '20', label: '20 — Docena' },
  { value: '13', label: '13 — Hora' },
  { value: '99', label: '99 — Otra' },
];

export function ProductosTab() {
  const productos = useDataStore(s => s.data.productos);
  const setCollection = useDataStore(s => s.set);

  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [search, setSearch] = useState('');

  const filtered = productos.filter(p => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return p.nombre.toLowerCase().includes(q)
      || (p.codigo?.toLowerCase() ?? '').includes(q)
      || (p.descripcion?.toLowerCase() ?? '').includes(q);
  });

  function openNew() {
    setForm(emptyForm);
    setEditId(null);
    setShowModal(true);
  }

  function openEdit(p: Producto) {
    setForm({
      codigo: p.codigo ?? '',
      nombre: p.nombre,
      descripcion: p.descripcion ?? '',
      tipo: p.tipo,
      precioUnitario: p.precioUnitario,
      uniMedida: String(p.uniMedida),
      codActividad: p.codActividad ?? '',
      activo: p.activo,
    });
    setEditId(p.id);
    setShowModal(true);
  }

  async function save() {
    if (!form.nombre.trim() || !form.precioUnitario) return;
    const payload: Producto = {
      id: editId ?? newId(),
      codigo: form.codigo.trim() || undefined,
      nombre: form.nombre.trim(),
      descripcion: form.descripcion.trim() || undefined,
      tipo: form.tipo,
      precioUnitario: num(form.precioUnitario).toFixed(2),
      uniMedida: parseInt(form.uniMedida, 10) || 59,
      codActividad: form.codActividad.trim() || undefined,
      activo: form.activo,
    };
    const next = editId
      ? productos.map(p => p.id === editId ? payload : p)
      : [...productos, payload];
    await setCollection('productos', next);
    setShowModal(false);
  }

  async function del(id: string) {
    await setCollection('productos', productos.filter(p => p.id !== id));
  }

  const formValid = !!(form.nombre.trim() && form.precioUnitario);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--s-5)', gap: 'var(--s-3)', flexWrap: 'wrap' }}>
        <Input
          type="search"
          placeholder="Buscar por nombre, código o descripción…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: '1 1 280px', maxWidth: 480 }}
        />
        <Button onClick={openNew} leading={<Icon name="plus" size={15} />}>
          Nuevo producto / servicio
        </Button>
      </div>

      <div className="table-wrap">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th style={{ width: 100 }}>Código</th>
                <th>Nombre</th>
                <th style={{ width: 90 }}>Tipo</th>
                <th className="num" style={{ width: 110 }}>Precio</th>
                <th style={{ width: 80 }}>Unidad</th>
                <th style={{ width: 80 }}>Estado</th>
                <th style={{ width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={7}>
                  <EmptyState
                    title={search ? 'Sin resultados' : 'Sin productos en el catálogo'}
                    description={search ? 'Prueba con otro término.' : 'Agrega tus productos y servicios para usarlos en facturación.'}
                  />
                </td></tr>
              )}
              {filtered.map(p => (
                <tr key={p.id}>
                  <td>
                    {p.codigo
                      ? <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>{p.codigo}</code>
                      : <span style={{ color: 'var(--fg-4)' }}>—</span>}
                  </td>
                  <td>
                    <div style={{ fontWeight: 500 }}>{p.nombre}</div>
                    {p.descripcion && (
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-3)', marginTop: 2 }}>
                        {p.descripcion}
                      </div>
                    )}
                  </td>
                  <td>
                    <span style={{
                      fontSize: 'var(--text-xs)', padding: '2px 8px',
                      borderRadius: 'var(--r-pill)',
                      background: p.tipo === 'servicio' ? 'var(--brand-primary-50)' : 'var(--surface-2)',
                      color: p.tipo === 'servicio' ? 'var(--brand-primary-700)' : 'var(--fg-2)',
                    }}>
                      {p.tipo === 'servicio' ? 'Servicio' : 'Bien'}
                    </span>
                  </td>
                  <td className="num"><strong>{fmt(p.precioUnitario)}</strong></td>
                  <td className="muted" style={{ fontSize: 'var(--text-xs)' }}>{p.uniMedida}</td>
                  <td>
                    {p.activo
                      ? <span style={{ color: 'var(--success-text)', fontSize: 'var(--text-xs)' }}>● Activo</span>
                      : <span style={{ color: 'var(--fg-4)', fontSize: 'var(--text-xs)' }}>○ Inactivo</span>}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 'var(--s-1)', justifyContent: 'flex-end' }}>
                      <button className="btn-icon" onClick={() => openEdit(p)} aria-label="Editar"><Icon name="edit" size={14} /></button>
                      <button className="btn-icon" style={{ color: 'var(--danger-text)' }} onClick={() => del(p.id)} aria-label="Eliminar"><Icon name="trash" size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showModal && (
        <Modal
          title={editId ? 'Editar producto' : 'Nuevo producto / servicio'}
          onClose={() => setShowModal(false)}
          onSave={save}
          saveDisabled={!formValid}
        >
          <div className="two-col">
            <Field label="Código (opcional)">
              <Input
                type="text"
                placeholder="SRV-001"
                value={form.codigo}
                onChange={e => setForm(p => ({ ...p, codigo: e.target.value.toUpperCase() }))}
              />
            </Field>
            <Field label="Tipo *">
              <Select value={form.tipo} onChange={e => setForm(p => ({ ...p, tipo: e.target.value as ProductoTipo }))}>
                {TIPO_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Nombre *">
            <Input
              type="text"
              placeholder="Consultoría por hora"
              value={form.nombre}
              onChange={e => setForm(p => ({ ...p, nombre: e.target.value }))}
            />
          </Field>
          <Field label="Descripción">
            <Input
              type="text"
              placeholder="Detalle del producto o servicio"
              value={form.descripcion}
              onChange={e => setForm(p => ({ ...p, descripcion: e.target.value }))}
            />
          </Field>
          <div className="two-col">
            <Field label="Precio unitario (sin IVA) *">
              <Input
                type="number"
                step="0.01"
                placeholder="0.00"
                value={form.precioUnitario}
                onChange={e => setForm(p => ({ ...p, precioUnitario: e.target.value }))}
              />
            </Field>
            <Field label="Unidad de medida (CAT-014)">
              <Select value={form.uniMedida} onChange={e => setForm(p => ({ ...p, uniMedida: e.target.value }))}>
                {UNI_MEDIDA_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            </Field>
          </div>
          <div className="two-col">
            <Field label="Código de actividad (opcional)">
              <Input
                type="text"
                placeholder="47711 (default = del emisor)"
                value={form.codActividad}
                onChange={e => setForm(p => ({ ...p, codActividad: e.target.value }))}
              />
            </Field>
            <Field label="Estado">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, height: 36, fontSize: 'var(--text-sm)' }}>
                <input
                  type="checkbox"
                  checked={form.activo}
                  onChange={e => setForm(p => ({ ...p, activo: e.target.checked }))}
                />
                Activo (visible en POS)
              </label>
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
