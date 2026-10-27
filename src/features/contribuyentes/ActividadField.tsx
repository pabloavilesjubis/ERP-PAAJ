import { useId } from 'react';
import { Field, Input } from '@/components/ui/Field';
import { ACTIVIDADES_ECONOMICAS, findActividad } from '@/lib/catalogos/mh';

/**
 * Actividad económica (CAT-019): se busca por código o por nombre en el
 * catálogo completo del MH. Si el código está en el catálogo la descripción
 * es la oficial (es la que viaja en el DTE); si no, se escribe a mano.
 */
export function ActividadField({ codigo, descripcion, onChange, required }: {
  codigo: string; descripcion: string; onChange: (codigo: string, descripcion: string) => void; required?: boolean;
}) {
  const listId = useId();
  const cat = findActividad(codigo);
  const mark = required ? ' *' : '';
  return (
    <>
      <Field label={`Actividad económica (código CAT-019)${mark}`} error={codigo && !/^\d{2,6}$/.test(codigo) ? 'De 2 a 6 dígitos' : undefined}>
        <Input list={listId} value={codigo} placeholder="Escribe código o nombre, ej. 96092 o servicios"
          onChange={ev => {
            const raw = ev.target.value;
            // Al elegir del datalist llega el código; si pegan "96092 — Servicios n.c.p." tomamos el código
            const cod = /^\s*\d{2,6}\b/.test(raw) ? raw.trim().match(/^\d{2,6}/)![0] : raw;
            const hit = findActividad(cod);
            onChange(cod, hit ? hit.nombre : (cat ? '' : descripcion));
          }} />
        <datalist id={listId}>{ACTIVIDADES_ECONOMICAS.map(a => <option key={a.codigo} value={a.codigo}>{a.nombre}</option>)}</datalist>
      </Field>
      <Field label={`Descripción de la actividad${mark}`}>
        <Input value={cat ? cat.nombre : descripcion} readOnly={!!cat} maxLength={150}
          placeholder={codigo ? 'Código fuera del catálogo: describe la actividad' : 'Se llena al elegir la actividad'}
          onChange={ev => onChange(codigo, ev.target.value)} />
      </Field>
    </>
  );
}
