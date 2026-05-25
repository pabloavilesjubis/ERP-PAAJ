import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { buildAnulacion } from '../src/dte/builders/anulacion.js';
import { buildCcf } from '../src/dte/builders/ccf.js';
import { buildFcf } from '../src/dte/builders/fcf.js';
import { buildFse } from '../src/dte/builders/fse.js';
import { buildNc } from '../src/dte/builders/nc.js';
import { getValidator } from '../src/dte/validate.js';

const cfg: Config = {
  NODE_ENV: 'test', LOG_LEVEL: 'info', PORT: 3000,
  MH_ENV: 'sandbox',
  MH_NIT: '06140000000000', MH_PASSWORD: 'x',
  FIRMADOR_URL: 'http://x', FIRMADOR_NIT: '06140000000000', FIRMADOR_PASSWORD: 'x',
  EMISOR_NRC: '1234567', EMISOR_NOMBRE: 'TEST SA DE CV',
  EMISOR_COD_ACTIVIDAD: '47711', EMISOR_DESC_ACTIVIDAD: 'Comercio',
  EMISOR_NOMBRE_COMERCIAL: 'TESTSV', EMISOR_TIPO_ESTABLECIMIENTO: '02',
  EMISOR_DEPARTAMENTO: '06', EMISOR_MUNICIPIO: '14', EMISOR_COMPLEMENTO: 'Calle X',
  EMISOR_TELEFONO: '22220000', EMISOR_EMAIL: 'test@test.sv',
  PUNTO_VENTA_ESTABLECIMIENTO: 'C001', PUNTO_VENTA_PUNTO: '0001',
  STORAGE_DIR: '/tmp/dte-test', BEON_ALLOWED_ORIGINS: '',
};

const baseFcfItem = {
  tipoItem: 2 as const, cantidad: 1, codigo: null, codTributo: null,
  numeroDocumento: null, uniMedida: 59,
  descripcion: 'Servicio', precioUni: 113, montoDescu: 0,
  ventaNoSuj: 0, ventaExenta: 0, ventaGravada: 113,
  tributos: null, psv: 0, noGravado: 0,
};

const ccfReceptor = {
  nit: '06141234567890', nrc: '9999991', nombre: 'CLIENTE SA DE CV',
  codActividad: '47711', descActividad: 'Comercio',
  nombreComercial: null, telefono: null, correo: 'c@c.sv',
  direccion: { departamento: '06', municipio: '14', complemento: 'Calle Y' },
};

const baseCcfItem = {
  tipoItem: 1 as const, cantidad: 1, codigo: null, codTributo: null,
  numeroDocumento: null, uniMedida: 59,
  descripcion: 'Producto', precioUni: 100, montoDescu: 0,
  ventaNoSuj: 0, ventaExenta: 0, ventaGravada: 100,
  tributos: ['20'], psv: 0, noGravado: 0,
};

function reportErrors(label: string, errors: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log(`\n[${label}] AJV reportó ${errors.length} errores:`);
  for (const e of errors) {
    // eslint-disable-next-line no-console
    console.log('  ·', JSON.stringify(e));
  }
}

describe('AJV — DTEs contra el schema oficial del MH', () => {
  it('FCF valida correctamente', () => {
    const dte = buildFcf(cfg, { consecutivo: 1, items: [baseFcfItem] });
    const validate = getValidator('fcf');
    const ok = validate(dte);
    if (!ok) reportErrors('FCF', validate.errors ?? []);
    expect(ok).toBe(true);
  });

  it('CCF valida correctamente', () => {
    const dte = buildCcf(cfg, {
      consecutivo: 1, receptor: ccfReceptor, items: [baseCcfItem],
    });
    const validate = getValidator('ccf');
    const ok = validate(dte);
    if (!ok) reportErrors('CCF', validate.errors ?? []);
    expect(ok).toBe(true);
  });

  it('NC valida correctamente', () => {
    const dte = buildNc(cfg, {
      consecutivo: 1,
      receptor: ccfReceptor,
      items: [{ ...baseCcfItem, numeroDocumento: 'F47AC10B-58CC-4372-A567-0E02B2C3D479' }],
      documentoRelacionado: [{
        tipoDocumento: '03', tipoGeneracion: 2,
        numeroDocumento: 'F47AC10B-58CC-4372-A567-0E02B2C3D479',
        fechaEmision: '2026-04-15',
      }],
    });
    const validate = getValidator('nc');
    const ok = validate(dte);
    if (!ok) reportErrors('NC', validate.errors ?? []);
    expect(ok).toBe(true);
  });

  it('FSE valida correctamente', () => {
    const dte = buildFse(cfg, {
      consecutivo: 1,
      sujetoExcluido: {
        tipoDocumento: '13', numDocumento: '012345678',
        nombre: 'Juan Pérez',
        codActividad: null, descActividad: null,
        telefono: null, correo: null,
        direccion: { departamento: '06', municipio: '14', complemento: 'Calle Z' },
      },
      items: [{
        tipoItem: 2, cantidad: 1, codigo: null, uniMedida: 59,
        descripcion: 'Servicio profesional', precioUni: 500, montoDescu: 0,
        compra: 500,
      }],
      reteRenta: 50,
    });
    const validate = getValidator('fse');
    const ok = validate(dte);
    if (!ok) reportErrors('FSE', validate.errors ?? []);
    expect(ok).toBe(true);
  });

  it('Anulación valida correctamente', () => {
    const evento = buildAnulacion(cfg, {
      tipoDte: '03',
      codigoGeneracion: 'F47AC10B-58CC-4372-A567-0E02B2C3D479',
      selloRecibido: 'A'.repeat(40),
      numeroControl: 'DTE-03-C0010001-000000000000001',
      fecEmi: '2026-04-30',
      montoIva: 13.00,
      tipoDocumentoReceptor: '36', numDocumentoReceptor: '06141234567890',
      nombreReceptor: 'CLIENTE SA DE CV',
      correoReceptor: 'cliente@test.sv',
      tipoAnulacion: 2,
      motivoAnulacion: 'Rescisión del contrato',
      nombreResponsable: 'Pablo Aviles', tipDocResponsable: '13', numDocResponsable: '123456789',
      nombreSolicita: 'Cliente', tipDocSolicita: '36', numDocSolicita: '06141234567890',
    });
    const validate = getValidator('anulacion');
    const ok = validate(evento);
    if (!ok) reportErrors('Anulación', validate.errors ?? []);
    expect(ok).toBe(true);
  });
});
