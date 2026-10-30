import { describe, expect, it } from 'vitest';
import { totalEnLetras } from '../src/dte/builders/common.js';

describe('totalEnLetras', () => {
  it.each([
    [555.56, 'QUINIENTOS CINCUENTA Y CINCO 56/100 DÓLARES'],
    [405.39, 'CUATROCIENTOS CINCO 39/100 DÓLARES'],
    [0.5, 'CERO 50/100 DÓLARES'],
    [1, 'UNO 00/100 DÓLARES'],
    [21, 'VEINTIUNO 00/100 DÓLARES'],
    [100, 'CIEN 00/100 DÓLARES'],
    [101.1, 'CIENTO UNO 10/100 DÓLARES'],
    [1000, 'MIL 00/100 DÓLARES'],
    [1250.75, 'MIL DOSCIENTOS CINCUENTA 75/100 DÓLARES'],
    [21000, 'VEINTIÚN MIL 00/100 DÓLARES'],
    [31500, 'TREINTA Y UN MIL QUINIENTOS 00/100 DÓLARES'],
    [100000, 'CIEN MIL 00/100 DÓLARES'],
    [1_000_000, 'UN MILLÓN 00/100 DÓLARES'],
    [2_345_678.9, 'DOS MILLONES TRESCIENTOS CUARENTA Y CINCO MIL SEISCIENTOS SETENTA Y OCHO 90/100 DÓLARES'],
  ])('%s', (monto, letras) => expect(totalEnLetras(monto)).toBe(letras));
});
