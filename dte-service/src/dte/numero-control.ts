import { ValidationError } from '../errors.js';

const ALPHANUM_4 = /^[A-Z0-9]{4}$/;
const TIPO_DTE_2D = /^\d{2}$/;

export interface NumeroControlInput {
  tipoDte: string;          // '01' | '03' | '05' | '14' (string 2-dígitos)
  establecimiento: string;  // 4 chars alfanuméricos en mayúscula
  puntoVenta: string;       // 4 chars alfanuméricos en mayúscula
  consecutivo: number;      // 1..999_999_999_999_999
}

/**
 * Construye un numeroControl válido según la spec del MH.
 * Formato: `DTE-NN-XXXXXXXX-NNNNNNNNNNNNNNN` (31 caracteres).
 *
 *   DTE   prefijo fijo
 *   NN    tipoDte (2 dígitos)
 *   XXXX  código del establecimiento (4 alfanum)
 *   XXXX  código del punto de venta  (4 alfanum)
 *   NN…   consecutivo (15 dígitos, padding con ceros a la izquierda)
 */
export function buildNumeroControl(input: NumeroControlInput): string {
  if (!TIPO_DTE_2D.test(input.tipoDte)) {
    throw new ValidationError('tipoDte debe ser exactamente 2 dígitos', { tipoDte: input.tipoDte });
  }
  if (!ALPHANUM_4.test(input.establecimiento)) {
    throw new ValidationError('establecimiento debe ser 4 chars alfanum en mayúscula', { establecimiento: input.establecimiento });
  }
  if (!ALPHANUM_4.test(input.puntoVenta)) {
    throw new ValidationError('puntoVenta debe ser 4 chars alfanum en mayúscula', { puntoVenta: input.puntoVenta });
  }
  if (!Number.isInteger(input.consecutivo) || input.consecutivo < 1 || input.consecutivo > 999_999_999_999_999) {
    throw new ValidationError('consecutivo fuera de rango [1..999999999999999]', { consecutivo: input.consecutivo });
  }
  const correlativo = String(input.consecutivo).padStart(15, '0');
  return `DTE-${input.tipoDte}-${input.establecimiento}${input.puntoVenta}-${correlativo}`;
}

/** UUIDv4 en mayúsculas, formato exigido por el MH. */
export function newCodigoGeneracion(): string {
  return crypto.randomUUID().toUpperCase();
}
