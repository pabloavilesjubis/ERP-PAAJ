import type { CorrelativoDte, TipoDteCode } from '@/types/domain';
import { newId } from '@/lib/utils/format';
import type { DteTipo } from './client';

/**
 * Helpers para gestionar el correlativo del último DTE emitido por tipo.
 * El MH NO acepta duplicados de numeroControl, así que tracker fielmente el
 * último consecutivo emitido es la diferencia entre éxito y rechazo masivo.
 */

const TIPO_TO_CODE: Record<DteTipo, TipoDteCode> = {
  fcf: '01',
  ccf: '03',
  nc: '05',
  fse: '14',
};

export function tipoDteToCodigo(tipo: DteTipo): TipoDteCode {
  return TIPO_TO_CODE[tipo];
}

export function codigoToTipoDte(codigo: TipoDteCode): DteTipo | null {
  for (const [k, v] of Object.entries(TIPO_TO_CODE)) {
    if (v === codigo) return k as DteTipo;
  }
  return null;
}

/** Devuelve el próximo consecutivo a usar para un tipo de DTE. */
export function getProximoConsecutivo(
  correlativos: CorrelativoDte[],
  tipoDte: TipoDteCode,
): number {
  const c = correlativos.find(r => r.tipoDte === tipoDte);
  return (c?.ultimoConsecutivo ?? 0) + 1;
}

/**
 * Devuelve la lista de correlativos con el de `tipoDte` actualizado al
 * nuevo `consecutivo` (que acaba de emitirse exitosamente). Crea la
 * entrada si no existía. Inmutable — devuelve nuevo array.
 */
export function bumpCorrelativo(
  correlativos: CorrelativoDte[],
  tipoDte: TipoDteCode,
  consecutivoUsado: number,
): CorrelativoDte[] {
  const existing = correlativos.find(r => r.tipoDte === tipoDte);
  if (existing) {
    return correlativos.map(r =>
      r.tipoDte === tipoDte
        ? { ...r, ultimoConsecutivo: Math.max(r.ultimoConsecutivo, consecutivoUsado) }
        : r,
    );
  }
  return [...correlativos, { id: newId(), tipoDte, ultimoConsecutivo: consecutivoUsado }];
}

/** Setea manualmente el ultimoConsecutivo (caso: migración desde otro sistema). */
export function setUltimoConsecutivo(
  correlativos: CorrelativoDte[],
  tipoDte: TipoDteCode,
  ultimo: number,
): CorrelativoDte[] {
  const existing = correlativos.find(r => r.tipoDte === tipoDte);
  if (existing) {
    return correlativos.map(r =>
      r.tipoDte === tipoDte ? { ...r, ultimoConsecutivo: ultimo } : r,
    );
  }
  return [...correlativos, { id: newId(), tipoDte, ultimoConsecutivo: ultimo }];
}
