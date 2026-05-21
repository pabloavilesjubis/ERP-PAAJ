import { describe, expect, it } from 'vitest';
import { buildFcf } from '../../src/dte/builders/fcf.js';
import { buildCcf } from '../../src/dte/builders/ccf.js';
import type { Config } from '../../src/config.js';

const cfg: Config = {
  NODE_ENV: 'test', LOG_LEVEL: 'info', PORT: 3000,
  MH_ENV: 'sandbox',
  MH_NIT: '06140000000000', MH_PASSWORD: 'x',
  FIRMADOR_URL: 'http://x', FIRMADOR_NIT: '06140000000000', FIRMADOR_PASSWORD: 'x',
  EMISOR_NRC: '123456-7', EMISOR_NOMBRE: 'TEST SA DE CV',
  EMISOR_COD_ACTIVIDAD: '47711', EMISOR_DESC_ACTIVIDAD: 'Comercio',
  EMISOR_NOMBRE_COMERCIAL: 'TEST', EMISOR_TIPO_ESTABLECIMIENTO: '02',
  EMISOR_DEPARTAMENTO: '06', EMISOR_MUNICIPIO: '14', EMISOR_COMPLEMENTO: 'Calle X',
  EMISOR_TELEFONO: '22220000', EMISOR_EMAIL: 'test@test.sv',
  PUNTO_VENTA_ESTABLECIMIENTO: 'C001', PUNTO_VENTA_PUNTO: '0001',
};

describe('buildFcf', () => {
  it('genera identificación con tipoDte=01 y numeroControl válido', () => {
    const dte = buildFcf(cfg, {
      consecutivo: 1,
      items: [{
        tipoItem: 1, cantidad: 2, codigo: 'A1', uniMedida: 59,
        descripcion: 'producto', precioUni: 11.30, montoDescu: 0,
        ventaNoSuj: 0, ventaExenta: 0, ventaGravada: 22.60,
        tributos: null, psv: 0, noGravado: 0, codTributo: null, numeroDocumento: null,
      }],
    });
    expect(dte.identificacion.tipoDte).toBe('01');
    expect(dte.identificacion.version).toBe(1);
    expect(dte.identificacion.ambiente).toBe('00');
    expect(dte.identificacion.numeroControl).toMatch(/^DTE-01-C0010001-\d{15}$/);
    expect(dte.identificacion.codigoGeneracion).toMatch(/^[0-9A-F-]{36}$/);
  });

  it('calcula IVA implícito en FCF (precios CON IVA)', () => {
    const dte = buildFcf(cfg, {
      consecutivo: 1,
      items: [{
        tipoItem: 1, cantidad: 1, codigo: null, uniMedida: 59,
        descripcion: 'test', precioUni: 113, montoDescu: 0,
        ventaNoSuj: 0, ventaExenta: 0, ventaGravada: 113,
        tributos: null, psv: 0, noGravado: 0, codTributo: null, numeroDocumento: null,
      }],
    });
    expect(dte.resumen.totalGravada).toBe(113);
    expect(dte.resumen.subTotal).toBe(113);
    expect(dte.resumen.totalIva).toBeCloseTo(13, 2);
    expect(dte.resumen.totalPagar).toBe(113);
    expect(dte.cuerpoDocumento[0]?.ivaItem).toBeCloseTo(13, 2);
  });

  it('admite receptor null para consumidor anónimo', () => {
    const dte = buildFcf(cfg, {
      consecutivo: 5,
      items: [{
        tipoItem: 2, cantidad: 1, codigo: null, uniMedida: 59,
        descripcion: 'servicio', precioUni: 50, montoDescu: 0,
        ventaNoSuj: 0, ventaExenta: 0, ventaGravada: 50,
        tributos: null, psv: 0, noGravado: 0, codTributo: null, numeroDocumento: null,
      }],
    });
    expect(dte.receptor).toBeNull();
  });
});

describe('buildCcf', () => {
  it('lista IVA 13% en tributos y suma al total', () => {
    const dte = buildCcf(cfg, {
      consecutivo: 1,
      receptor: {
        nit: '06141234567890', nrc: '999999-1', nombre: 'CLIENTE SA',
        codActividad: '47711', descActividad: 'Comercio',
        nombreComercial: null, telefono: null, correo: 'c@c.sv',
        direccion: { departamento: '06', municipio: '14', complemento: 'X' },
      },
      items: [{
        tipoItem: 1, cantidad: 1, codigo: null, uniMedida: 59,
        descripcion: 'test', precioUni: 100, montoDescu: 0,
        ventaNoSuj: 0, ventaExenta: 0, ventaGravada: 100,
        tributos: null, psv: 0, noGravado: 0, codTributo: null, numeroDocumento: null,
      }],
    });
    expect(dte.resumen.totalGravada).toBe(100);
    expect(dte.resumen.tributos).toEqual([
      { codigo: '20', descripcion: 'Impuesto al Valor Agregado 13%', valor: 13 },
    ]);
    expect(dte.resumen.montoTotalOperacion).toBe(113);
  });

  it('aplica retenciones (rete IVA 1% + rete Renta) al total', () => {
    const dte = buildCcf(cfg, {
      consecutivo: 1,
      receptor: {
        nit: '06141234567890', nrc: '999999-1', nombre: 'CLIENTE',
        codActividad: '47711', descActividad: 'Comercio',
        nombreComercial: null, telefono: null, correo: 'c@c.sv',
        direccion: { departamento: '06', municipio: '14', complemento: 'X' },
      },
      items: [{
        tipoItem: 1, cantidad: 1, codigo: null, uniMedida: 59,
        descripcion: 'test', precioUni: 1000, montoDescu: 0,
        ventaNoSuj: 0, ventaExenta: 0, ventaGravada: 1000,
        tributos: null, psv: 0, noGravado: 0, codTributo: null, numeroDocumento: null,
      }],
      ivaRete1: 10,        // 1% de 1000
      reteRenta: 100,      // 10% de 1000
    });
    // 1000 + 130 (IVA) - 10 (rete IVA) - 100 (rete renta) = 1020
    expect(dte.resumen.montoTotalOperacion).toBe(1020);
  });
});
