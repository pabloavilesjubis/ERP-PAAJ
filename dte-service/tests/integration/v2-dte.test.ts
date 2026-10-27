import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { auth, createTenant, db, hasDb, type TestTenant } from './helpers.js';

// Sin firmador ni MH reales: se verifica que cada empresa emita y anule con lo suyo
const signedWith: string[] = [];
vi.mock('../../src/signing/firmador.js', () => ({
  firmar: async (cfg: { FIRMADOR_NIT: string }) => { signedWith.push(cfg.FIRMADOR_NIT); return 'h.p.s'; },
}));
vi.mock('../../src/mh/submit.js', () => ({
  submitDte: async () => ({ estado: 'PROCESADO', selloRecibido: 'S'.repeat(40), raw: { estado: 'PROCESADO', fhProcesamiento: null } }),
}));
vi.mock('../../src/mh/annul.js', () => ({
  annulDte: async () => ({ selloRecibido: 'E'.repeat(40), raw: { estado: 'PROCESADO' } }),
}));

const FCF = {
  items: [{ tipoItem: 1, cantidad: 1, codigo: null, uniMedida: 59, descripcion: 'servicio', precioUni: 113, montoDescu: 0,
    ventaNoSuj: 0, ventaExenta: 0, ventaGravada: 113, tributos: null, psv: 0, noGravado: 0, codTributo: null, numeroDocumento: null }],
};

describe.skipIf(!hasDb)('DTE v2 por empresa', () => {
  let app: FastifyInstance;
  let a: TestTenant;
  let b: TestTenant;

  beforeAll(async () => {
    const { errorHandler } = await import('../../src/http/error-handler.js');
    const { registerV2Routes } = await import('../../src/v2/dte.routes.js');
    const { upsertEmisor, EmisorInput } = await import('../../src/tenants/emisor.service.js');
    const corr = await import('../../src/tenants/correlativo.repo.js');
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    registerV2Routes(app, { STORAGE_DIR: process.env.FIRMADOR_CERTS_DIR, MH_ENV: 'sandbox' } as never);
    await app.ready();
    a = await createTenant();
    b = await createTenant();
    const base = { mh_env: 'sandbox', emisor_nrc: '1234567', emisor_cod_actividad: '96092', emisor_desc_actividad: 'Servicios n.c.p.',
      emisor_tipo_establecimiento: '02', emisor_departamento: '06', emisor_municipio: '14', emisor_complemento: 'San Salvador',
      emisor_telefono: '22220000', emisor_email: 'fe@test.sv', punto_venta_establecimiento: 'M001', punto_venta_punto: 'P001',
      mh_password: 'x', firmador_password: 'y' };
    await upsertEmisor(a.tenantId, EmisorInput.parse({ ...base, mh_nit: '06149999990011', emisor_nombre: 'EMPRESA A' }));
    await upsertEmisor(b.tenantId, EmisorInput.parse({ ...base, mh_nit: '06149999990022', emisor_nombre: 'EMPRESA B' }));
    await corr.sembrar(a.tenantId, '01', 60);
    await corr.sembrar(b.tenantId, '01', 15);
  });
  afterAll(async () => { await app?.close(); });

  let codGen: string;
  it('emite con el NIT y el correlativo de la empresa de la sesión, y devuelve el JWS', async () => {
    const res = await app.inject({ method: 'POST', url: '/v2/dte/emit', headers: auth(a.token), payload: { tipo: 'fcf', data: FCF } });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.consecutivo).toBe(61);
    expect(body.numeroControl).toMatch(/-000000000000061$/);
    expect(body.documento).toBe('h.p.s');
    expect(body.dte.emisor.nit).toBe('06149999990011');
    expect(signedWith.at(-1)).toBe('06149999990011');
    codGen = body.codigoGeneracion;
    const { query } = await db();
    expect((await query('SELECT ultimo_consumido FROM tenant_correlativos WHERE tenant_id = $1 AND tipo_dte = $2', [b.tenantId, '01'])).rows[0]!.ultimo_consumido)
      .toBe('15');   // la otra empresa no se mueve
  });

  const annul = () => ({
    tipoDte: '01', codigoGeneracion: codGen, selloRecibido: 'S'.repeat(40), numeroControl: 'DTE-01-M001P001-000000000000061',
    fecEmi: new Date().toISOString().slice(0, 10), montoIva: 13, tipoDocumentoReceptor: '13', numDocumentoReceptor: '123456789',
    nombreReceptor: 'Cliente', tipoAnulacion: 2, motivoAnulacion: 'Rescisión', nombreResponsable: 'Admin', tipDocResponsable: '13',
    numDocResponsable: '123456789', nombreSolicita: 'Cliente', tipDocSolicita: '13', numDocSolicita: '123456789',
  });

  it('otra empresa no puede anular el DTE; la dueña sí, una sola vez', async () => {
    const foreign = await app.inject({ method: 'POST', url: '/v2/dte/annul', headers: auth(b.token), payload: annul() });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().message).toMatch(/no fue emitido por esta empresa/);
    const ok = await app.inject({ method: 'POST', url: '/v2/dte/annul', headers: auth(a.token), payload: annul() });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(signedWith.at(-1)).toBe('06149999990011');
    const { query } = await db();
    const row = (await query('SELECT estado, anulacion FROM dtes WHERE tenant_id = $1 AND codigo_generacion = $2', [a.tenantId, codGen])).rows[0]!;
    expect(row.estado).toBe('ANULADO');
    expect(row.anulacion.motivo).toBe('Rescisión');
    expect((await app.inject({ method: 'POST', url: '/v2/dte/annul', headers: auth(a.token), payload: annul() })).statusCode).toBe(400);
  });
});
