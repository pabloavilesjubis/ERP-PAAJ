import type { Contribuyente, ContribuyenteTipo } from '@/types/domain';
import { newId } from './format';

/**
 * Asegura que un contribuyente exista en el catálogo:
 *   - Si no existe (matched por NRC), lo crea con el rol indicado.
 *   - Si existe con el rol opuesto, lo asciende a "Ambos".
 *   - Si ya existe con el rol correcto o como "Ambos", no cambia nada.
 *
 * Devuelve la lista actualizada y la acción tomada para que la UI pueda
 * mostrar feedback al usuario.
 */

export type EnsureAction = 'created' | 'upgraded-to-ambos' | 'unchanged' | 'skipped';

export interface EnsureContribuyenteResult {
  list: Contribuyente[];
  action: EnsureAction;
  contribuyente: Contribuyente | null;
}

export interface EnsureContribuyenteInput {
  nombre: string;
  nrc: string;
  nit?: string;
  dui?: string;
  role: 'Cliente' | 'Proveedor';
}

export function ensureContribuyente(
  existing: Contribuyente[],
  input: EnsureContribuyenteInput,
): EnsureContribuyenteResult {
  const nombre = input.nombre.trim();
  const nrc = input.nrc.trim();

  // Sin nombre o NRC no creamos nada — no hay forma de identificarlo.
  if (!nombre || !nrc) {
    return { list: existing, action: 'skipped', contribuyente: null };
  }

  const match = existing.find(c => c.nrc === nrc);

  if (match) {
    // Determina si necesitamos propagar nuevos datos (NIT/DUI) cuando el match
    // los tenía vacíos. Esto evita perder identidad fiscal capturada en compra/venta.
    const needsNitFill = !match.nit && !!input.nit;
    const needsDuiFill = !match.dui && !!input.dui;
    const needsRoleUpgrade = match.tipo !== input.role && match.tipo !== 'Ambos';

    // Ya está en el rol correcto, o ya es Ambos, y ya tiene NIT/DUI: no hacer nada.
    if (!needsRoleUpgrade && !needsNitFill && !needsDuiFill) {
      return { list: existing, action: 'unchanged', contribuyente: match };
    }

    const upgraded: Contribuyente = {
      ...match,
      tipo: needsRoleUpgrade ? ('Ambos' as ContribuyenteTipo) : match.tipo,
      nit: match.nit || (input.nit ?? ''),
      dui: match.dui || input.dui,
    };
    return {
      list: existing.map(c => c.id === match.id ? upgraded : c),
      action: needsRoleUpgrade ? 'upgraded-to-ambos' : 'unchanged',
      contribuyente: upgraded,
    };
  }

  // No existe — crear nuevo.
  const created: Contribuyente = {
    id: newId(),
    nombre,
    nit: input.nit ?? '',
    dui: input.dui,
    nrc,
    tipo: input.role,
  };
  return {
    list: [...existing, created],
    action: 'created',
    contribuyente: created,
  };
}
