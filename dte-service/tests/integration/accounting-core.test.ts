import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { auth, buildApp, createTenant, db, hasDb, type TestTenant } from './helpers.js';
import { balances, setupAccounting } from './accounting.helpers.js';

describe.skipIf(!hasDb)('núcleo contable', () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let ids: Map<string, number>;

  beforeAll(async () => {
    app = await buildApp();
    t = await createTenant();
    ids = await setupAccounting(app, t);
  });
  afterAll(async () => { await app?.close(); });

  const entry = (payload: Record<string, unknown>, token = t.token) =>
    app.inject({ method: 'POST', url: '/v2/acc/entries', headers: auth(token), payload });

  it('importa el catálogo derivando padres, niveles y cuentas de mayor', async () => {
    const res = await app.inject({ method: 'GET', url: '/v2/acc/accounts', headers: auth(t.token) });
    const byCode = new Map(res.json().items.map((a: { code: string }) => [a.code, a]));
    const caja = byCode.get('1.1.01.01') as { level: number; allows_movements: boolean; nature: string };
    expect(caja.level).toBe(4);
    expect(caja.allows_movements).toBe(true);
    expect(caja.nature).toBe('Deudora');
    expect((byCode.get('1.1.01') as { allows_movements: boolean }).allows_movements).toBe(false);
    expect((byCode.get('5.1') as { financial_statement: string }).financial_statement).toBe('ER');
    // reimportar actualiza sin duplicar
    const again = await app.inject({ method: 'POST', url: '/v2/acc/accounts/import', headers: auth(t.token),
      payload: { rows: [{ code: '1.1.01.01', name: 'Caja general (renombrada)', account_type: 'Activo' }] } });
    expect(again.json()).toEqual({ inserted: 0, updated: 1 });
  });

  it('acepta catálogos sin puntos (código por dígitos)', async () => {
    const other = await createTenant();
    const res = await app.inject({ method: 'POST', url: '/v2/acc/accounts/import', headers: auth(other.token), payload: { rows: [
      { code: '1', name: 'ACTIVO', account_type: 'activo' },
      { code: '11', name: 'CORRIENTE', account_type: 'activo' },
      { code: '1101', name: 'Caja', account_type: 'activo' },
    ] } });
    expect(res.statusCode, res.body).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/v2/acc/accounts', headers: auth(other.token) });
    const caja = list.json().items.find((a: { code: string }) => a.code === '1101');
    expect(caja.level).toBe(3);
  });

  it('contabiliza una partida manual cuadrada y rechaza una descuadrada', async () => {
    const ok = await entry({ entry_date: '2026-03-05', concept: 'Aporte de capital', post: true, lines: [
      { account_id: ids.get('1.1.01.03'), debit: 1000 },
      { account_id: ids.get('3.1'), credit: 1000 },
    ] });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().entry_number).toBeGreaterThan(0);

    const bad = await entry({ entry_date: '2026-03-05', concept: 'Descuadre', post: true, lines: [
      { account_id: ids.get('1.1.01.01'), debit: 100 },
      { account_id: ids.get('3.1'), credit: 90 },
    ] });
    expect(bad.statusCode).toBe(400);
  });

  it('no acepta cuentas de mayor ni cuentas de otra empresa', async () => {
    const mayor = await entry({ entry_date: '2026-03-05', concept: 'x', post: true, lines: [
      { account_id: ids.get('1.1.01'), debit: 10 }, { account_id: ids.get('3.1'), credit: 10 },
    ] });
    expect(mayor.statusCode).toBe(400);
    const other = await createTenant();
    const foreign = await entry({ entry_date: '2026-03-05', concept: 'x', post: true, lines: [
      { account_id: ids.get('1.1.01.01'), debit: 10 }, { account_id: ids.get('3.1'), credit: 10 },
    ] }, other.token);
    expect(foreign.statusCode).toBe(400);
  });

  it('un asiento contabilizado es inmutable y se anula con reversión enlazada', async () => {
    const e = await entry({ entry_date: '2026-03-10', concept: 'Gasto de papelería', post: true, lines: [
      { account_id: ids.get('4.2.01'), debit: 25 }, { account_id: ids.get('1.1.01.01'), credit: 25 },
    ] });
    const id = e.json().id;
    const { query } = await db();
    await expect(query('UPDATE accounting.journal_lines SET debit = 30 WHERE entry_id = $1 AND debit > 0', [id])).rejects.toThrow(/no se puede modificar/);
    await expect(query('DELETE FROM accounting.journal_entries WHERE id = $1', [id])).rejects.toThrow(/no se puede eliminar/);

    const before = await balances(app, t);
    const v = await app.inject({ method: 'POST', url: `/v2/acc/entries/${id}/void`, headers: auth(t.token), payload: { reason: 'Duplicado' } });
    expect(v.statusCode, v.body).toBe(200);
    const after = await balances(app, t);
    expect(after.get('4.2.01')).toBe((before.get('4.2.01') ?? 0) - 25);
    const detail = await app.inject({ method: 'GET', url: `/v2/acc/entries/${id}`, headers: auth(t.token) });
    expect(detail.json().entry.status).toBe('anulado');
    const rev = await app.inject({ method: 'GET', url: `/v2/acc/entries/${v.json().reversal_id}`, headers: auth(t.token) });
    // período abierto: la reversión cae en la fecha del original
    expect(rev.json().entry.entry_date.slice(0, 10)).toBe('2026-03-10');
  });

  it('un período cerrado bloquea registros y se puede reabrir con motivo', async () => {
    const draft = await entry({ entry_date: '2026-01-15', concept: 'Borrador', lines: [
      { account_id: ids.get('4.2.01'), debit: 5 }, { account_id: ids.get('1.1.01.01'), credit: 5 },
    ] });
    const blocked = await app.inject({ method: 'POST', url: '/v2/acc/periods/close', headers: auth(t.token), payload: { year: 2026, month: 1 } });
    expect(blocked.statusCode).toBe(400);   // tiene borradores
    await app.inject({ method: 'DELETE', url: `/v2/acc/entries/${draft.json().id}`, headers: auth(t.token) });
    const closed = await app.inject({ method: 'POST', url: '/v2/acc/periods/close', headers: auth(t.token), payload: { year: 2026, month: 1 } });
    expect(closed.statusCode, closed.body).toBe(200);

    const late = await entry({ entry_date: '2026-01-20', concept: 'Tarde', post: true, lines: [
      { account_id: ids.get('4.2.01'), debit: 5 }, { account_id: ids.get('1.1.01.01'), credit: 5 },
    ] });
    expect(late.statusCode).toBe(400);
    expect(late.json().message).toMatch(/cerrado/);

    const noReason = await app.inject({ method: 'POST', url: '/v2/acc/periods/reopen', headers: auth(t.token), payload: { year: 2026, month: 1 } });
    expect(noReason.statusCode).toBe(400);
    const reopened = await app.inject({ method: 'POST', url: '/v2/acc/periods/reopen', headers: auth(t.token), payload: { year: 2026, month: 1, notes: 'Ajuste de auditoría' } });
    expect(reopened.statusCode).toBe(200);
  });

  it('el auxiliar registra partidas pero no cierra períodos ni configura', async () => {
    const aux = await t.tokenFor('auxiliar');
    const ok = await entry({ entry_date: '2026-03-12', concept: 'Aux', post: true, lines: [
      { account_id: ids.get('4.2.01'), debit: 1 }, { account_id: ids.get('1.1.01.01'), credit: 1 },
    ] }, aux);
    expect(ok.statusCode).toBe(200);
    const close = await app.inject({ method: 'POST', url: '/v2/acc/periods/close', headers: auth(aux), payload: { year: 2026, month: 2 } });
    expect(close.statusCode).toBe(403);
    const cfg = await app.inject({ method: 'PUT', url: '/v2/acc/roles', headers: auth(aux), payload: { assignments: {} } });
    expect(cfg.statusCode).toBe(403);
  });

  it('libro mayor con saldo inicial y saldos iniciales como partida de apertura', async () => {
    const op = await app.inject({ method: 'POST', url: '/v2/acc/opening/import', headers: auth(t.token), payload: {
      entry_date: '2026-02-01', rows: [
        { code: '1.1.01.01', debit: 500 }, { code: '1.2.01', debit: 1500 }, { code: '3.1', credit: 2000 },
      ] } });
    expect(op.statusCode, op.body).toBe(200);
    const post = await app.inject({ method: 'POST', url: `/v2/acc/entries/${op.json().id}/post`, headers: auth(t.token) });
    expect(post.statusCode, post.body).toBe(200);

    const ledger = await app.inject({ method: 'GET', url: `/v2/acc/reports/ledger?account_id=${ids.get('1.1.01')}&from=2026-03-01&to=2026-03-31`, headers: auth(t.token) });
    expect(ledger.statusCode).toBe(200);
    expect(ledger.json().opening).toBe(500);   // la apertura de febrero en caja general
    expect(ledger.json().items.length).toBeGreaterThan(0);
  });

  it('create_entry es idempotente por documento y evento', async () => {
    const { query } = await db();
    const lines = JSON.stringify([{ account_id: ids.get('1.1.01.01'), debit: 10 }, { account_id: ids.get('5.1'), credit: 10 }]);
    const a = await query<{ id: string }>(`SELECT accounting.create_entry($1, '2026-03-20', 'TEST', 'test', 'doc-1', 'Doc 1', 'Prueba', $2::jsonb) AS id`, [t.tenantId, lines]);
    const b = await query<{ id: string }>(`SELECT accounting.create_entry($1, '2026-03-20', 'TEST', 'test', 'doc-1', 'Doc 1', 'Prueba', $2::jsonb) AS id`, [t.tenantId, lines]);
    expect(a.rows[0]!.id).toBe(b.rows[0]!.id);
    // tras anular, el documento puede volver a contabilizarse
    await query(`SELECT accounting.reverse_source($1, 'test', 'doc-1', 'TEST', 'Editado')`, [t.tenantId]);
    const c = await query<{ id: string }>(`SELECT accounting.create_entry($1, '2026-03-20', 'TEST', 'test', 'doc-1', 'Doc 1', 'Prueba', $2::jsonb) AS id`, [t.tenantId, lines]);
    expect(c.rows[0]!.id).not.toBe(a.rows[0]!.id);
  });

  it('la balanza cuadra', async () => {
    const res = await app.inject({ method: 'GET', url: '/v2/acc/reports/movements?from=2026-01-01&to=2026-12-31', headers: auth(t.token) });
    const items = res.json().items as Array<{ debit: number; credit: number; debit_before: number; credit_before: number }>;
    const d = items.reduce((s, m) => s + m.debit + m.debit_before, 0);
    const c = items.reduce((s, m) => s + m.credit + m.credit_before, 0);
    expect(Math.round(d * 100)).toBe(Math.round(c * 100));
  });
});
