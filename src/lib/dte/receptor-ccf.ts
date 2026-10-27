import { findActividad } from '@/lib/catalogos/mh';
import type { Contribuyente } from '@/types/domain';

/**
 * Datos mínimos que el schema fe-ccf-v3 exige del receptor (también aplica a
 * la NC, que reusa el receptor del CCF). Devuelve la lista de lo que falta o
 * está mal, en texto para mostrar al usuario; vacía = se le puede emitir CCF.
 *
 * nombreComercial es nullable y telefono puede ir null, así que no se exigen
 * (el teléfono solo se valida si viene).
 */
export function faltantesCcf(c: Pick<Contribuyente,
  'nombre' | 'nit' | 'nrc' | 'codActividad' | 'giro' | 'departamento' | 'municipio' | 'direccion' | 'email' | 'telefono'>): string[] {
  const out: string[] = [];
  const nit = (c.nit ?? '').replace(/\D/g, '');
  const nrc = (c.nrc ?? '').replace(/\D/g, '');
  const cod = (c.codActividad ?? '').trim();
  const desc = (findActividad(cod)?.nombre ?? c.giro ?? '').trim();
  const email = (c.email ?? '').trim();
  const tel = (c.telefono ?? '').trim();

  if (!c.nombre?.trim()) out.push('Nombre o razón social');
  if (!/^(\d{14}|\d{9})$/.test(nit)) out.push('NIT (14 o 9 dígitos)');
  if (!/^\d{1,8}$/.test(nrc)) out.push('NRC (hasta 8 dígitos)');
  if (!/^\d{2,6}$/.test(cod)) out.push('Actividad económica (código)');
  else if (!desc) out.push('Descripción de la actividad');
  if (!/^\d{2}$/.test(c.departamento ?? '') || !/^\d{2}$/.test(c.municipio ?? '')) out.push('Departamento y municipio');
  if (!(c.direccion ?? '').trim()) out.push('Dirección (calle, colonia, número)');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) out.push('Correo electrónico');
  if (tel && tel.length < 8) out.push('Teléfono (mínimo 8 caracteres)');
  return out;
}
