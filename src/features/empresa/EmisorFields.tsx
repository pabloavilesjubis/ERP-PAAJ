import { Field, Input, Select } from '@/components/ui/Field';
import { ACTIVIDADES_ECONOMICAS, DEPARTAMENTOS, findActividad, getMunicipiosFor } from '@/lib/catalogos/mh';
import type { Emisor } from '@/features/admin/api';

/**
 * Formulario de datos fiscales del emisor, común a "Mi empresa" y a la consola
 * de plataforma. Departamento, municipio y actividad salen de los catálogos
 * del MH (CAT-012/013/019); la actividad admite códigos fuera de la lista.
 */

export const EMPTY_EMISOR: Emisor = {
  mh_env: 'production', mh_nit: '', emisor_nrc: '', emisor_nombre: '', emisor_cod_actividad: '', emisor_desc_actividad: '',
  emisor_tipo_establecimiento: '02', emisor_departamento: '', emisor_municipio: '', emisor_complemento: '', emisor_telefono: null,
  emisor_email: '', punto_venta_establecimiento: 'M001', punto_venta_punto: 'P001', emisor_cod_estable_mh: null, emisor_cod_punto_venta_mh: null,
  mh_password: '', firmador_password: '',
};

/** Recorta textos, manda null en opcionales vacíos y omite claves vacías (= conservar). */
export function cleanEmisor(e: Emisor): Emisor {
  const out = { ...e } as Record<string, unknown>;
  for (const [k, v] of Object.entries(out)) if (typeof v === 'string') out[k] = v.trim();
  for (const k of ['emisor_telefono', 'emisor_cod_estable_mh', 'emisor_cod_punto_venta_mh']) if (!out[k]) out[k] = null;
  if (!out.mh_password) delete out.mh_password;
  if (!out.firmador_password) delete out.firmador_password;
  return out as unknown as Emisor;
}

export const fileToBase64 = (file: File) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1] ?? '');
  r.onerror = rej;
  r.readAsDataURL(file);
});

const TIPOS_ESTABLECIMIENTO = [
  { codigo: '02', nombre: 'Casa matriz' }, { codigo: '01', nombre: 'Sucursal / agencia' },
  { codigo: '04', nombre: 'Bodega' }, { codigo: '07', nombre: 'Predio y/o patio' }, { codigo: '20', nombre: 'Otro' },
];

export function EmisorFields({ e, setE, requirePasswords, showPasswords = true }: {
  e: Emisor; setE: (e: Emisor) => void; requirePasswords: boolean; showPasswords?: boolean;
}) {
  const f = (k: keyof Emisor) => ({ value: (e[k] as string | null) ?? '', onChange: (ev: { target: { value: string } }) => setE({ ...e, [k]: ev.target.value }) });
  const pw = requirePasswords ? '' : ' (vacío = conservar)';
  const munis = getMunicipiosFor(e.emisor_departamento);
  const nitDigits = e.mh_nit.replace(/\D/g, '');
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
      <Field label="Nombre o razón social"><Input {...f('emisor_nombre')} /></Field>
      <Field label="NIT (14 dígitos)" error={nitDigits && nitDigits.length !== 14 ? `Tiene ${nitDigits.length} dígitos` : undefined}>
        <Input {...f('mh_nit')} placeholder="0614-010101-101-1" />
      </Field>
      <Field label="NRC"><Input {...f('emisor_nrc')} placeholder="123456-7" /></Field>
      <Field label="Actividad económica (código)">
        <Input list="mh-actividades" value={e.emisor_cod_actividad} onChange={ev => {
          const cod = ev.target.value.trim();
          const cat = findActividad(cod);
          setE({ ...e, emisor_cod_actividad: cod, emisor_desc_actividad: cat ? cat.nombre : e.emisor_desc_actividad });
        }} placeholder="46900" />
        <datalist id="mh-actividades">{ACTIVIDADES_ECONOMICAS.map(a => <option key={a.codigo} value={a.codigo}>{a.nombre}</option>)}</datalist>
      </Field>
      <Field label="Descripción de la actividad"><Input {...f('emisor_desc_actividad')} /></Field>
      <Field label="Tipo de establecimiento">
        <Select {...f('emisor_tipo_establecimiento')}>
          {TIPOS_ESTABLECIMIENTO.map(t => <option key={t.codigo} value={t.codigo}>{t.codigo} · {t.nombre}</option>)}
        </Select>
      </Field>
      <Field label="Departamento">
        <Select value={e.emisor_departamento} onChange={ev => setE({ ...e, emisor_departamento: ev.target.value, emisor_municipio: '' })}>
          <option value="">Elegir…</option>
          {DEPARTAMENTOS.map(d => <option key={d.codigo} value={d.codigo}>{d.codigo} · {d.nombre}</option>)}
        </Select>
      </Field>
      <Field label="Municipio">
        <Select {...f('emisor_municipio')} disabled={!e.emisor_departamento}>
          <option value="">Elegir…</option>
          {e.emisor_municipio && !munis.some(m => m.codigo === e.emisor_municipio) && <option value={e.emisor_municipio}>{e.emisor_municipio}</option>}
          {munis.map(m => <option key={m.codigo} value={m.codigo}>{m.codigo} · {m.nombre}</option>)}
        </Select>
      </Field>
      <Field label="Dirección (complemento)"><Input {...f('emisor_complemento')} placeholder="Calle, número, colonia" /></Field>
      <Field label="Teléfono"><Input {...f('emisor_telefono')} /></Field>
      <Field label="Email para facturación"><Input type="email" {...f('emisor_email')} /></Field>
      <Field label="Ambiente del MH">
        <Select value={e.mh_env} onChange={ev => setE({ ...e, mh_env: ev.target.value as Emisor['mh_env'] })}>
          <option value="production">Producción</option><option value="sandbox">Pruebas (sandbox)</option>
        </Select>
      </Field>
      <Field label="Código de establecimiento (4)"><Input {...f('punto_venta_establecimiento')} placeholder="M001" /></Field>
      <Field label="Código de punto de venta (4)"><Input {...f('punto_venta_punto')} placeholder="P001" /></Field>
      <Field label="Cód. establecimiento asignado por MH (opcional)"><Input {...f('emisor_cod_estable_mh')} /></Field>
      <Field label="Cód. punto de venta asignado por MH (opcional)"><Input {...f('emisor_cod_punto_venta_mh')} /></Field>
      {showPasswords && <>
        <Field label={`Clave API del MH${pw}`}><Input type="password" autoComplete="new-password" {...f('mh_password')} /></Field>
        <Field label={`Clave privada del certificado${pw}`}><Input type="password" autoComplete="new-password" {...f('firmador_password')} /></Field>
      </>}
    </div>
  );
}
