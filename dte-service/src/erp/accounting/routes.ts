import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePerm } from '../../auth/auth.middleware.js';
import { ValidationError } from '../../errors.js';
import { authedPlugin, ctx, dateRange, idParam, intParam, parse, q, tx } from '../http.js';

/**
 * Núcleo contable (F1): catálogo, reglas de cuentas, asientos, partidas
 * manuales, libros y períodos. Toda la lógica de integridad vive en las
 * funciones `accounting.*` (migración 006); aquí solo se valida la entrada,
 * se fija el contexto (empresa/usuario) y se consulta.
 */

const ACCOUNT_TYPES = ['Activo', 'Contraactivo', 'Pasivo', 'Patrimonio', 'Ingreso', 'Costo', 'Gasto', 'Resultado'] as const;
const ER_TYPES = new Set(['Ingreso', 'Costo', 'Gasto', 'Resultado']);
const MANUAL_KINDS = ['ajuste', 'reclasificacion', 'depreciacion', 'provision', 'correccion', 'cierre', 'apertura', 'otro'] as const;

const money = z.union([z.number(), z.string()]).transform(v => (typeof v === 'number' ? v : parseFloat(v || '0')))
  .refine(v => Number.isFinite(v) && v >= 0, 'Monto inválido');

const AccountBody = z.object({
  code: z.string().trim().regex(/^[0-9]+([.-][0-9]+)*$/, 'Código inválido: solo dígitos separados por punto o guion'),
  name: z.string().trim().min(1, 'Indica el nombre'),
  account_type: z.enum(ACCOUNT_TYPES),
  nature: z.enum(['Deudora', 'Acreedora', 'Mixta']).optional(),
  parent_id: z.number().int().positive().nullable().optional(),
  balance_term: z.enum(['corriente', 'no_corriente']).nullable().optional(),
  result_section: z.string().trim().max(80).nullable().optional(),
  allows_movements: z.boolean().default(true),
  is_active: z.boolean().default(true),
});

const ImportBody = z.object({
  rows: z.array(z.object({
    code: z.string(), name: z.string(), account_type: z.string(),
    nature: z.string().optional().nullable(), parent_code: z.string().optional().nullable(),
    financial_statement: z.string().optional().nullable(),
    allows_movements: z.boolean().optional().nullable(), is_active: z.boolean().optional().nullable(),
    balance_term: z.enum(['corriente', 'no_corriente']).optional().nullable(),
    result_section: z.string().optional().nullable(),
  })).min(1, 'El archivo no tiene cuentas').max(5000),
});

const Line = z.object({
  account_id: z.number().int().positive(),
  debit: money.optional(),
  credit: money.optional(),
  description: z.string().max(300).optional().nullable(),
  party_id: z.number().int().positive().optional().nullable(),
  cost_center: z.string().max(60).optional().nullable(),
  reference: z.string().max(120).optional().nullable(),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)');

const ManualBody = z.object({
  id: z.number().int().positive().optional().nullable(),
  entry_date: isoDate,
  manual_kind: z.enum(MANUAL_KINDS).default('ajuste'),
  concept: z.string().trim().min(1, 'Indica el concepto').max(300),
  notes: z.string().max(2000).optional().nullable(),
  lines: z.array(Line).max(500),
  post: z.boolean().default(false),
});

const OpeningBody = z.object({
  entry_date: isoDate,
  rows: z.array(z.object({
    code: z.string().trim().min(1),
    debit: money.optional(),
    credit: money.optional(),
    description: z.string().optional().nullable(),
  })).min(1).max(5000),
});

export async function registerAccountingRoutes(app: FastifyInstance): Promise<void> {
  await authedPlugin(app, (r) => {
    // ── Resumen de configuración (para guiar a una empresa nueva) ────────────
    r.get('/v2/acc/setup', { preHandler: requirePerm('accounting:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const res = await q<{ accounts: number; movement_accounts: number; roles: number; entries: number }>(`
        SELECT (SELECT count(*)::int FROM accounting.accounts WHERE tenant_id = $1) AS accounts,
               (SELECT count(*)::int FROM accounting.accounts WHERE tenant_id = $1 AND allows_movements) AS movement_accounts,
               (SELECT count(*)::int FROM accounting.account_roles WHERE tenant_id = $1) AS roles,
               (SELECT count(*)::int FROM accounting.journal_entries WHERE tenant_id = $1 AND status <> 'borrador') AS entries`,
        [tenantId]);
      const missing = await q<{ role_key: string; label: string }>(`
        SELECT d.role_key, d.label FROM accounting.role_definitions d
         WHERE NOT EXISTS (SELECT 1 FROM accounting.account_roles r WHERE r.tenant_id = $1 AND r.role_key = d.role_key)
         ORDER BY d.sort_order`, [tenantId]);
      return { ...res.rows[0], missing_roles: missing.rows };
    });

    // ── Catálogo ─────────────────────────────────────────────────────────────
    r.get('/v2/acc/accounts', { preHandler: requirePerm('accounting:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const res = await q(`
        SELECT a.id, a.code, a.name, a.account_type, a.nature, a.parent_id, a.level, a.financial_statement,
               a.affects_result, a.result_section, a.balance_term, a.allows_movements, a.is_active,
               EXISTS (SELECT 1 FROM accounting.journal_lines l WHERE l.account_id = a.id) AS has_movements
          FROM accounting.accounts a
         WHERE a.tenant_id = $1
         ORDER BY a.code`, [tenantId]);
      return { items: res.rows };
    });

    r.post('/v2/acc/accounts', { preHandler: requirePerm('accounting:config') }, async (req) => {
      const c = ctx(req);
      const b = parse(AccountBody, req.body);
      const fs = ER_TYPES.has(b.account_type) ? 'ER' : 'Balance';
      const res = await q<{ id: number }>(`
        INSERT INTO accounting.accounts (tenant_id, code, name, account_type, nature, parent_id, financial_statement,
                                         affects_result, result_section, balance_term, allows_movements, is_active, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
        [c.tenantId, b.code, b.name, b.account_type, b.nature ?? defaultNature(b.account_type), b.parent_id ?? null,
         fs, fs === 'ER', b.result_section ?? null, b.balance_term ?? null, b.allows_movements, b.is_active, c.userId]);
      return { id: res.rows[0]!.id };
    });

    r.put('/v2/acc/accounts/:id', { preHandler: requirePerm('accounting:config') }, async (req) => {
      const c = ctx(req);
      const id = idParam(req);
      const b = parse(AccountBody, req.body);
      const fs = ER_TYPES.has(b.account_type) ? 'ER' : 'Balance';
      const res = await q(`
        UPDATE accounting.accounts SET code = $3, name = $4, account_type = $5, nature = $6, parent_id = $7,
               financial_statement = $8, affects_result = $9, result_section = $10, balance_term = $11,
               allows_movements = $12, is_active = $13
         WHERE id = $1 AND tenant_id = $2 RETURNING id`,
        [id, c.tenantId, b.code, b.name, b.account_type, b.nature ?? defaultNature(b.account_type), b.parent_id ?? null,
         fs, fs === 'ER', b.result_section ?? null, b.balance_term ?? null, b.allows_movements, b.is_active]);
      if (!res.rows.length) throw new ValidationError('Cuenta no encontrada');
      return { success: true };
    });

    r.delete('/v2/acc/accounts/:id', { preHandler: requirePerm('accounting:config') }, async (req) => {
      const c = ctx(req);
      const id = idParam(req);
      const used = await q<{ moves: boolean; children: boolean; role: boolean }>(`
        SELECT EXISTS (SELECT 1 FROM accounting.journal_lines WHERE account_id = $1) AS moves,
               EXISTS (SELECT 1 FROM accounting.accounts WHERE parent_id = $1) AS children,
               EXISTS (SELECT 1 FROM accounting.account_roles WHERE account_id = $1) AS role`, [id]);
      const u = used.rows[0]!;
      if (u.moves) throw new ValidationError('La cuenta tiene movimientos: desactívala en lugar de eliminarla');
      if (u.children) throw new ValidationError('La cuenta tiene subcuentas');
      if (u.role) throw new ValidationError('La cuenta está asignada en Configuración contable');
      const res = await q('DELETE FROM accounting.accounts WHERE id = $1 AND tenant_id = $2 RETURNING id', [id, c.tenantId]);
      if (!res.rows.length) throw new ValidationError('Cuenta no encontrada');
      return { success: true };
    });

    r.post('/v2/acc/accounts/import', { preHandler: requirePerm('accounting:config') }, async (req) => {
      const c = ctx(req);
      const b = parse(ImportBody, req.body);
      const out = await tx(async (db) => {
        const res = await db.query<{ r: { inserted: number; updated: number } }>(
          'SELECT accounting.import_accounts($1, $2::jsonb) AS r', [c.tenantId, JSON.stringify(b.rows)]);
        return res.rows[0]!.r;
      }, c);
      return out;
    });

    // ── Reglas de contabilización (roles → cuentas) ──────────────────────────
    r.get('/v2/acc/roles', { preHandler: requirePerm('accounting:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const res = await q(`
        SELECT d.role_key, d.label, d.group_name, d.description, d.sort_order,
               r.account_id, a.code AS account_code, a.name AS account_name
          FROM accounting.role_definitions d
          LEFT JOIN accounting.account_roles r ON r.role_key = d.role_key AND r.tenant_id = $1
          LEFT JOIN accounting.accounts a ON a.id = r.account_id
         ORDER BY d.sort_order, d.role_key`, [tenantId]);
      return { items: res.rows };
    });

    r.put('/v2/acc/roles', { preHandler: requirePerm('accounting:config') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({ assignments: z.record(z.number().int().positive().nullable()) }), req.body);
      await tx(async (db) => {
        for (const [role, accountId] of Object.entries(b.assignments)) {
          if (accountId === null) {
            await db.query('DELETE FROM accounting.account_roles WHERE tenant_id = $1 AND role_key = $2', [c.tenantId, role]);
            continue;
          }
          const acc = await db.query<{ allows_movements: boolean }>(
            'SELECT allows_movements FROM accounting.accounts WHERE id = $1 AND tenant_id = $2', [accountId, c.tenantId]);
          if (!acc.rows.length) throw new ValidationError(`Cuenta ${accountId} no encontrada`);
          if (!acc.rows[0]!.allows_movements) throw new ValidationError('Solo se asignan cuentas de movimiento');
          await db.query(`
            INSERT INTO accounting.account_roles (tenant_id, role_key, account_id) VALUES ($1, $2, $3)
            ON CONFLICT (tenant_id, role_key) DO UPDATE SET account_id = EXCLUDED.account_id, updated_at = NOW()`,
            [c.tenantId, role, accountId]);
        }
      }, c);
      return { success: true };
    });

    // ── Asientos ─────────────────────────────────────────────────────────────
    r.get('/v2/acc/entries', { preHandler: requirePerm('accounting:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const qp = req.query as Record<string, string | undefined>;
      const { from, to } = dateRange(qp);
      const params: unknown[] = [tenantId, from, to];
      let where = 'e.tenant_id = $1 AND e.entry_date BETWEEN $2 AND $3';
      if (qp.status === 'sin_revisar') where += ` AND e.status = 'contabilizado'`;
      else if (qp.status) { params.push(qp.status); where += ` AND e.status = $${params.length}`; }
      if (qp.type) { params.push(qp.type); where += ` AND e.entry_type = $${params.length}`; }
      if (qp.module) { params.push(qp.module); where += ` AND e.source_module = $${params.length}`; }
      if (qp.q) {
        params.push(`%${qp.q.trim()}%`);
        const like = `$${params.length}`;
        if (/^\d+$/.test(qp.q.trim())) {
          params.push(parseInt(qp.q.trim(), 10));
          where += ` AND (e.concept ILIKE ${like} OR e.source_ref ILIKE ${like} OR e.entry_number = $${params.length})`;
        } else {
          where += ` AND (e.concept ILIKE ${like} OR e.source_ref ILIKE ${like})`;
        }
      }
      const limit = intParam(qp.limit, 200, 2000);
      const offset = intParam(qp.offset, 0, 1_000_000);
      const res = await q(`
        SELECT e.id, e.entry_number, e.entry_date, e.entry_type, e.manual_kind, e.concept, e.source_module, e.source_id,
               e.source_ref, e.event_type, e.status, e.total_debit, e.total_credit, e.created_by_name, e.reviewed_by_name,
               e.reversal_of, e.reversed_by,
               count(*) OVER () AS total_count
          FROM accounting.journal_entries e
         WHERE ${where}
         ORDER BY e.entry_date DESC, e.entry_number DESC NULLS FIRST, e.id DESC
         LIMIT ${limit} OFFSET ${offset}`, params);
      const total = res.rows[0] ? Number((res.rows[0] as { total_count: string }).total_count) : 0;
      return { items: res.rows.map(({ total_count: _t, ...row }) => row), total };
    });

    r.get('/v2/acc/entries/:id', { preHandler: requirePerm('accounting:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const id = idParam(req);
      const e = await q(`
        SELECT e.*, rv.entry_number AS reversed_by_number, ro.entry_number AS reversal_of_number
          FROM accounting.journal_entries e
          LEFT JOIN accounting.journal_entries rv ON rv.id = e.reversed_by
          LEFT JOIN accounting.journal_entries ro ON ro.id = e.reversal_of
         WHERE e.id = $1 AND e.tenant_id = $2`, [id, tenantId]);
      if (!e.rows.length) throw new ValidationError('Asiento no encontrado');
      const lines = await q(`
        SELECT l.id, l.line_no, l.account_id, a.code AS account_code, a.name AS account_name, l.description,
               l.debit, l.credit, l.party_id, c.nombre AS party_name, l.cost_center, l.reference
          FROM accounting.journal_lines l
          JOIN accounting.accounts a ON a.id = l.account_id
          LEFT JOIN public.contribuyentes c ON c.id = l.party_id
         WHERE l.entry_id = $1 ORDER BY l.line_no`, [id]);
      return { entry: e.rows[0], lines: lines.rows };
    });

    r.post('/v2/acc/entries', { preHandler: requirePerm('accounting:post') }, async (req) => {
      const c = ctx(req);
      const b = parse(ManualBody, req.body);
      return tx(async (db) => {
        const saved = await db.query<{ id: string }>(
          'SELECT accounting.save_manual_entry($1, $2, $3, $4, $5, $6, $7::jsonb) AS id',
          [c.tenantId, b.id ?? null, b.entry_date, b.manual_kind, b.concept, b.notes ?? null, JSON.stringify(b.lines)]);
        const id = Number(saved.rows[0]!.id);
        let entryNumber: number | null = null;
        if (b.post) {
          const p = await db.query<{ n: string }>('SELECT accounting.post_manual_entry($1, $2) AS n', [c.tenantId, id]);
          entryNumber = Number(p.rows[0]!.n);
        }
        return { id, entry_number: entryNumber };
      }, c);
    });

    r.post('/v2/acc/entries/:id/post', { preHandler: requirePerm('accounting:post') }, async (req) => {
      const c = ctx(req);
      const id = idParam(req);
      return tx(async (db) => {
        const p = await db.query<{ n: string }>('SELECT accounting.post_manual_entry($1, $2) AS n', [c.tenantId, id]);
        return { id, entry_number: Number(p.rows[0]!.n) };
      }, c);
    });

    r.delete('/v2/acc/entries/:id', { preHandler: requirePerm('accounting:post') }, async (req) => {
      const c = ctx(req);
      await tx(db => db.query('SELECT accounting.delete_manual_draft($1, $2)', [c.tenantId, idParam(req)]), c);
      return { success: true };
    });

    r.post('/v2/acc/entries/:id/review', { preHandler: requirePerm('accounting:review') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({ notes: z.string().max(1000).optional().nullable() }), req.body);
      await tx(db => db.query('SELECT accounting.review_entry($1, $2, $3)', [c.tenantId, idParam(req), b.notes ?? null]), c);
      return { success: true };
    });

    r.post('/v2/acc/entries/:id/void', { preHandler: requirePerm('accounting:post') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({ reason: z.string().trim().min(3, 'Indica el motivo de la anulación') }), req.body);
      const rev = await tx(db => db.query<{ id: string }>('SELECT accounting.void_manual_entry($1, $2, $3) AS id',
        [c.tenantId, idParam(req), b.reason]), c);
      return { reversal_id: Number(rev.rows[0]!.id) };
    });

    // ── Saldos iniciales: crea una partida de apertura en borrador ───────────
    r.post('/v2/acc/opening/import', { preHandler: requirePerm('accounting:post') }, async (req) => {
      const c = ctx(req);
      const b = parse(OpeningBody, req.body);
      const accounts = await q<{ id: string; code: string; allows_movements: boolean }>(
        'SELECT id, code, allows_movements FROM accounting.accounts WHERE tenant_id = $1', [c.tenantId]);
      const byCode = new Map(accounts.rows.map(a => [a.code, a]));
      const lines = b.rows.map((row, i) => {
        const acc = byCode.get(row.code.trim());
        if (!acc) throw new ValidationError(`Fila ${i + 1}: la cuenta ${row.code} no existe en el catálogo`);
        if (!acc.allows_movements) throw new ValidationError(`Fila ${i + 1}: la cuenta ${row.code} es de mayor`);
        return { account_id: Number(acc.id), debit: row.debit ?? 0, credit: row.credit ?? 0, description: row.description ?? 'Saldo inicial' };
      });
      return tx(async (db) => {
        const saved = await db.query<{ id: string }>(
          `SELECT accounting.save_manual_entry($1, NULL, $2, 'apertura', 'Partida de apertura — saldos iniciales', NULL, $3::jsonb) AS id`,
          [c.tenantId, b.entry_date, JSON.stringify(lines)]);
        return { id: Number(saved.rows[0]!.id) };
      }, c);
    });

    // ── Reportes / libros ────────────────────────────────────────────────────
    r.get('/v2/acc/reports/movements', { preHandler: requirePerm('accounting:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const { from, to } = dateRange(req.query as Record<string, unknown>);
      const res = await q(`SELECT account_id, debit_before::float8, credit_before::float8, debit::float8, credit::float8
                                 FROM accounting.account_movements($1, $2, $3)`, [tenantId, from, to]);
      return { from, to, items: res.rows };
    });

    r.get('/v2/acc/reports/ledger', { preHandler: requirePerm('accounting:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const qp = req.query as Record<string, string | undefined>;
      const { from, to } = dateRange(qp);
      const accountId = parseInt(qp.account_id ?? '', 10);
      if (!Number.isFinite(accountId)) throw new ValidationError('Indica la cuenta');
      const [opening, lines] = await Promise.all([
        q<{ b: string }>('SELECT accounting.account_balance_before($1, $2, $3) AS b', [tenantId, accountId, from]),
        q(`SELECT entry_id, entry_number, entry_date, entry_type, status, concept, source_ref, line_no, account_id,
                      account_code, account_name, description, party_name, debit::float8, credit::float8
                 FROM accounting.account_ledger($1, $2, $3, $4)`, [tenantId, accountId, from, to]),
      ]);
      return { from, to, opening: Number(opening.rows[0]?.b ?? 0), items: lines.rows };
    });

    r.get('/v2/acc/reports/journal', { preHandler: requirePerm('accounting:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const qp = req.query as Record<string, string | undefined>;
      const { from, to } = dateRange(qp);
      const limit = intParam(qp.limit, 500, 5000);
      const offset = intParam(qp.offset, 0, 1_000_000);
      const entries = await q<{ id: string }>(`
        SELECT id, entry_number, entry_date, entry_type, manual_kind, concept, source_ref, status, total_debit::float8, total_credit::float8
          FROM accounting.journal_entries
         WHERE tenant_id = $1 AND status <> 'borrador' AND entry_date BETWEEN $2 AND $3
         ORDER BY entry_date, entry_number
         LIMIT ${limit} OFFSET ${offset}`, [tenantId, from, to]);
      const ids = entries.rows.map(e => e.id);
      const lines = ids.length ? await q<{ entry_id: string }>(`
        SELECT l.entry_id, l.line_no, a.code AS account_code, a.name AS account_name, l.description,
               l.debit::float8, l.credit::float8, c.nombre AS party_name
          FROM accounting.journal_lines l
          JOIN accounting.accounts a ON a.id = l.account_id
          LEFT JOIN public.contribuyentes c ON c.id = l.party_id
         WHERE l.entry_id = ANY($1::bigint[]) ORDER BY l.entry_id, l.line_no`, [ids]) : { rows: [] };
      const byEntry = new Map<string, unknown[]>();
      for (const l of lines.rows) {
        const k = String(l.entry_id);
        if (!byEntry.has(k)) byEntry.set(k, []);
        byEntry.get(k)!.push(l);
      }
      return { from, to, items: entries.rows.map(e => ({ ...e, lines: byEntry.get(String(e.id)) ?? [] })) };
    });

    // ── Períodos ─────────────────────────────────────────────────────────────
    r.get('/v2/acc/periods', { preHandler: requirePerm('accounting:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const year = intParam((req.query as Record<string, string>).year, new Date().getFullYear(), 2100);
      const res = await q(`
        SELECT m AS month,
               coalesce(p.status, 'abierto') AS status, p.closed_at, p.closed_by, p.reopened_at, p.reopened_by, p.notes,
               (SELECT count(*)::int FROM accounting.journal_entries e
                 WHERE e.tenant_id = $1 AND e.status <> 'borrador'
                   AND e.entry_date >= make_date($2, m, 1) AND e.entry_date < make_date($2, m, 1) + INTERVAL '1 month') AS entries,
               (SELECT count(*)::int FROM accounting.journal_entries e
                 WHERE e.tenant_id = $1 AND e.status = 'borrador'
                   AND e.entry_date >= make_date($2, m, 1) AND e.entry_date < make_date($2, m, 1) + INTERVAL '1 month') AS drafts
          FROM generate_series(1, 12) m
          LEFT JOIN accounting.periods p ON p.tenant_id = $1 AND p.year = $2 AND p.month = m
         ORDER BY m`, [tenantId, year]);
      return { year, items: res.rows };
    });

    const PeriodBody = z.object({
      year: z.number().int().min(2000).max(2100),
      month: z.number().int().min(1).max(12),
      notes: z.string().max(500).optional().nullable(),
    });

    r.post('/v2/acc/periods/close', { preHandler: requirePerm('accounting:close') }, async (req) => {
      const c = ctx(req);
      const b = parse(PeriodBody, req.body);
      await tx(async (db) => {
        const drafts = await db.query<{ n: number }>(`
          SELECT count(*)::int AS n FROM accounting.journal_entries
           WHERE tenant_id = $1 AND status = 'borrador'
             AND entry_date >= make_date($2, $3, 1) AND entry_date < make_date($2, $3, 1) + INTERVAL '1 month'`,
          [c.tenantId, b.year, b.month]);
        if ((drafts.rows[0]?.n ?? 0) > 0) {
          throw new ValidationError(`Hay ${drafts.rows[0]!.n} partida(s) en borrador en ese mes: contabilízalas o elimínalas antes de cerrar`);
        }
        await db.query(`
          INSERT INTO accounting.periods (tenant_id, year, month, status, closed_at, closed_by, notes)
          VALUES ($1, $2, $3, 'cerrado', NOW(), $4, $5)
          ON CONFLICT (tenant_id, year, month) DO UPDATE
            SET status = 'cerrado', closed_at = NOW(), closed_by = $4, notes = COALESCE($5, accounting.periods.notes)`,
          [c.tenantId, b.year, b.month, c.userName, b.notes ?? null]);
      }, c);
      return { success: true };
    });

    r.post('/v2/acc/periods/reopen', { preHandler: requirePerm('accounting:close') }, async (req) => {
      const c = ctx(req);
      const b = parse(PeriodBody.extend({ notes: z.string().trim().min(3, 'Indica el motivo de la reapertura') }), req.body);
      const res = await q(`
        UPDATE accounting.periods SET status = 'abierto', reopened_at = NOW(), reopened_by = $4, notes = $5
         WHERE tenant_id = $1 AND year = $2 AND month = $3 AND status = 'cerrado' RETURNING month`,
        [c.tenantId, b.year, b.month, c.userName, b.notes]);
      if (!res.rows.length) throw new ValidationError('Ese período no está cerrado');
      await q(`INSERT INTO audit_events (tenant_id, user_id, event_type, payload) VALUES ($1, $2, 'PERIOD_REOPENED', $3::jsonb)`,
        [c.tenantId, c.userId, JSON.stringify(b)]);
      return { success: true };
    });
  });
}

function defaultNature(type: string): 'Deudora' | 'Acreedora' | 'Mixta' {
  if (type === 'Activo' || type === 'Costo' || type === 'Gasto') return 'Deudora';
  if (type === 'Resultado') return 'Mixta';
  return 'Acreedora';
}
