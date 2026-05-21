/**
 * Detector de documentos duplicados.
 *
 * Reglas de unicidad fiscal — una venta o compra es ÚNICA si comparte
 * cualquiera de estos identificadores con otro registro:
 *   - Número de Control (DTE-XX-...)
 *   - Código de Generación / Número de Documento (UUID 32 hex)
 *   - Sello de Recepción
 *
 * Si cualquiera coincide → es el mismo documento. El sistema bloquea
 * la operación con un mensaje claro al usuario.
 *
 * Las comparaciones de UUID son case-insensitive y normalizan guiones
 * (porque el JSON viene con guiones y el CSV del MH sin guiones).
 */

export interface DocFingerprint {
  numeroControl?: string;
  codigoGeneracion?: string;     // VentaConsumidor lo guarda con este nombre
  numeroDocumento?: string;       // Compra y VentaContribuyente lo guardan con este nombre
  selloRecibido?: string;
}

export interface ExistingRecord {
  id: string;
  metadata?: DocFingerprint | null;
}

export type DuplicateField = 'numeroControl' | 'codigoGeneracion' | 'selloRecibido';

export interface DuplicateMatch {
  existingId: string;
  matchedField: DuplicateField;
  matchedValue: string;
}

function normUuid(s: string | undefined | null): string {
  return (s ?? '').replace(/[-\s]/g, '').toUpperCase().trim();
}

function normString(s: string | undefined | null): string {
  return (s ?? '').trim();
}

/**
 * Devuelve la primera coincidencia encontrada o `null` si no hay duplicado.
 * Pasa `excludeId` cuando estás editando un registro existente — así no se
 * marca como duplicado de sí mismo.
 */
export function findDuplicate<T extends ExistingRecord>(
  existing: T[],
  candidate: DocFingerprint,
  excludeId?: string,
): DuplicateMatch | null {
  // Pre-normalizamos el candidato una sola vez
  const cNumControl = normString(candidate.numeroControl);
  const cUuid = normUuid(candidate.codigoGeneracion ?? candidate.numeroDocumento);
  const cSello = normString(candidate.selloRecibido);

  for (const r of existing) {
    if (excludeId && r.id === excludeId) continue;
    const m = r.metadata;
    if (!m) continue;

    // Núm. Control (DTE-XX-...): comparación directa, case-sensitive
    if (cNumControl) {
      const e = normString(m.numeroControl);
      if (e && e === cNumControl) {
        return { existingId: r.id, matchedField: 'numeroControl', matchedValue: cNumControl };
      }
    }

    // Código de Generación / Número de Documento: normalizar UUID
    if (cUuid) {
      const e = normUuid(m.codigoGeneracion ?? m.numeroDocumento);
      if (e && e === cUuid) {
        return {
          existingId: r.id,
          matchedField: 'codigoGeneracion',
          matchedValue: candidate.codigoGeneracion ?? candidate.numeroDocumento ?? cUuid,
        };
      }
    }

    // Sello de Recepción: comparación directa
    if (cSello) {
      const e = normString(m.selloRecibido);
      if (e && e === cSello) {
        return { existingId: r.id, matchedField: 'selloRecibido', matchedValue: cSello };
      }
    }
  }
  return null;
}

/** Mensaje legible para mostrar al usuario. */
export function describeDuplicate(match: DuplicateMatch): string {
  const labels: Record<DuplicateField, string> = {
    numeroControl: 'Número de Control DTE',
    codigoGeneracion: 'Código de Generación',
    selloRecibido: 'Sello de Recepción',
  };
  return `Ya existe un documento con el mismo ${labels[match.matchedField]} (${match.matchedValue.slice(0, 40)}${match.matchedValue.length > 40 ? '…' : ''}).`;
}
