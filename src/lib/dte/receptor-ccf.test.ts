import { describe, expect, it } from 'vitest';
import { findActividad } from '@/lib/catalogos/mh';
import { faltantesCcf } from './receptor-ccf';

const completo = {
  nombre: 'ACME S.A. DE C.V.', nit: '0614-010101-101-1', nrc: '123456-7', codActividad: '96092', giro: '',
  departamento: '06', municipio: '14', direccion: 'Col. Escalón #15', email: 'fe@acme.sv', telefono: '',
};

describe('faltantesCcf', () => {
  it('acepta un receptor con el mínimo del CCF (teléfono opcional)', () => {
    expect(faltantesCcf(completo)).toEqual([]);
  });

  it('lista lo que falta', () => {
    expect(faltantesCcf({ ...completo, nit: '', email: 'x', direccion: ' ', codActividad: '' }))
      .toEqual(['NIT (14 o 9 dígitos)', 'Actividad económica (código)', 'Dirección (calle, colonia, número)', 'Correo electrónico']);
  });

  it('un código fuera del catálogo necesita descripción', () => {
    expect(faltantesCcf({ ...completo, codActividad: '12345' })).toEqual(['Descripción de la actividad']);
    expect(faltantesCcf({ ...completo, codActividad: '12345', giro: 'Mi actividad' })).toEqual([]);
  });

  it('el catálogo trae Servicios n.c.p. y los códigos especiales del MH', () => {
    expect(findActividad('96092')?.nombre).toBe('Servicios n.c.p.');
    expect(findActividad('10005')?.nombre).toBe('Otros');
  });
});
