import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePerm } from '../../auth/auth.middleware.js';
import { ValidationError } from '../../errors.js';
import { authedPlugin, ctx, idParam, intParam, parse, q, tx } from '../http.js';

/**
 * Bancos (F4): cuentas bancarias por empresa, importación de estados de
 * cuenta, conciliación y disponibilidad. La lógica vive en las funciones
 * accounting.* de la migración 009.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)');

const CsvMapping = z.object({
  delimiter: z.string().max(3).optional(),
  skip_rows: z.number().int().min(0).max(100).optional(),
  date_col: z.string().max(80).optional(),
  date_format: z.enum(['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD']).optional(),
  description_col: z.string().max(80).optional(),
  reference_col: z.string().max(80).optional(),
  debit_col: z.string().max(80).optional(),
  credit_col: z.string().max(80).optional(),
  amount_col: z.string().max(80).optional(),
  balance_col: z.string().max(80).optional(),
}).partial();

const AccountBody = z.object({
  bank_name: z.string().trim().min(2, 'Indica el banco').max(80),
  account_number: z.string().trim().min(3, 'Indica el número de cuenta').max(40),
  account_type: z.enum(['corriente', 'ahorro', 'otra']).default('corriente'),
  ledger_account_id: z.number().int().positive(),
  statement_format: z.enum(['bac', 'generic']).default('generic'),
  csv_mapping: CsvMapping.default({}),
  is_active: z.boolean().default(true),
});

const ImportBody = z.object({
  file_name: z.string().max(200).nullable().optional(),
  file_account: z.string().max(60).nullable().optional(),
  opening_balance: z.number().nullable().optional(),
  closing_balance: z.number().nullable().optional(),
  totals_ok: z.boolean().nullable().optional(),
  rows: z.array(z.object({
    date: isoDate,
    reference: z.string().max(120).nullable().optional(),
    code: z.string().max(40).nullable().optional(),
    description: z.string().max(500).nullable().optional(),
    debit: z.number().min(0),
    credit: z.number().min(0),
    balance: z.number().nullable().optional(),
  })).min(1, 'El archivo no tiene movimientos').max(20000),
});

const ACCOUNT_SELECT = `
  SELECT b.id, b.bank_name, b.account_number, b.account_type, b.currency, b.ledger_account_id, b.statement_format,
         b.csv_mapping, b.is_active, a.code AS ledger_code, a.name AS ledger_name,
         (SELECT max(period_to) FROM accounting.bank_imports i WHERE i.bank_account_id = b.id) AS last_statement_date,
         coalesce(
           (SELECT m.balance FROM accounting.bank_movements m WHERE m.bank_account_id = b.id AND m.balance IS NOT NULL
             ORDER BY m.movement_date DESC, m.id DESC LIMIT 1),
           (SELECT i.closing_balance FROM accounting.bank_imports i WHERE i.bank_account_id = b.id AND i.closing_balance IS NOT NULL
             ORDER BY i.period_to DESC, i.id DESC LIMIT 1)) AS statement_balance,
         accounting.ledger_balance(b.tenant_id, b.ledger_account_id, CURRENT_DATE) AS ledger_balance,
         (SELECT count(*)::int FROM accounting.bank_movements m WHERE m.bank_account_id = b.id AND m.status = 'pendiente') AS pending
    FROM accounting.bank_accounts b JOIN accounting.accounts a ON a.id = b.ledger_account_id`;

export async function registerBankRoutes(app: FastifyInstance): Promise<void> {
  await authedPlugin(app, (r) => {
    r.get('/v2/banks/accounts', { preHandler: requirePerm('banks:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const res = await q(`${ACCOUNT_SELECT} WHERE b.tenant_id = $1 ORDER BY b.is_active DESC, b.bank_name, b.account_number`, [tenantId]);
      return { items: res.rows };
    });

    const saveAccount = async (tenantId: number, b: z.infer<typeof AccountBody>, id?: number) => {
      const acc = await q<{ allows_movements: boolean; account_type: string }>(
        'SELECT allows_movements, account_type FROM accounting.accounts WHERE id = $1 AND tenant_id = $2', [b.ledger_account_id, tenantId]);
      if (!acc.rows[0]?.allows_movements) throw new ValidationError('La cuenta contable debe ser de movimiento');
      if (acc.rows[0].account_type !== 'Activo') throw new ValidationError('La cuenta contable de un banco debe ser de tipo Activo');
      if (id) {
        const res = await q(`UPDATE accounting.bank_accounts SET bank_name = $3, account_number = $4, account_type = $5, ledger_account_id = $6,
                               statement_format = $7, csv_mapping = $8::jsonb, is_active = $9 WHERE id = $1 AND tenant_id = $2 RETURNING id`,
          [id, tenantId, b.bank_name, b.account_number, b.account_type, b.ledger_account_id, b.statement_format, JSON.stringify(b.csv_mapping), b.is_active]);
        if (!res.rows.length) throw new ValidationError('Cuenta bancaria no encontrada');
        return id;
      }
      const res = await q<{ id: number }>(`INSERT INTO accounting.bank_accounts (tenant_id, bank_name, account_number, account_type, ledger_account_id,
                                             statement_format, csv_mapping, is_active)
                                           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING id`,
        [tenantId, b.bank_name, b.account_number, b.account_type, b.ledger_account_id, b.statement_format, JSON.stringify(b.csv_mapping), b.is_active]);
      return res.rows[0]!.id;
    };

    r.post('/v2/banks/accounts', { preHandler: requirePerm('banks:manage') }, async (req) => {
      const { tenantId } = ctx(req);
      return { id: await saveAccount(tenantId, parse(AccountBody, req.body)) };
    });

    r.put('/v2/banks/accounts/:id', { preHandler: requirePerm('banks:manage') }, async (req) => {
      const { tenantId } = ctx(req);
      return { id: await saveAccount(tenantId, parse(AccountBody, req.body), idParam(req)) };
    });

    r.post('/v2/banks/accounts/:id/import', { preHandler: requirePerm('banks:manage') }, async (req) => {
      const c = ctx(req);
      const id = idParam(req);
      const b = parse(ImportBody, req.body);
      const out = await tx(async (db) => {
        const imp = await q<{ r: { import_id: number; rows: number; new: number; duplicates: number } }>(
          'SELECT accounting.import_bank_statement($1, $2, $3, $4, $5, $6, $7, $8::jsonb) AS r',
          [c.tenantId, id, b.file_name ?? null, b.file_account ?? null, b.opening_balance ?? null, b.closing_balance ?? null,
           b.totals_ok ?? null, JSON.stringify(b.rows)], db);
        return imp.rows[0]!.r;
      }, c);
      const auto = await tx(db => q<{ n: number }>('SELECT accounting.auto_reconcile($1, $2) AS n', [c.tenantId, id], db), c);
      return { ...out, auto_reconciled: auto.rows[0]!.n };
    });

    r.get('/v2/banks/accounts/:id/imports', { preHandler: requirePerm('banks:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const res = await q(`SELECT * FROM accounting.bank_imports WHERE tenant_id = $1 AND bank_account_id = $2 ORDER BY id DESC LIMIT 100`,
        [tenantId, idParam(req)]);
      return { items: res.rows };
    });

    r.post('/v2/banks/accounts/:id/auto-reconcile', { preHandler: requirePerm('banks:manage') }, async (req) => {
      const c = ctx(req);
      const res = await tx(db => q<{ n: number }>('SELECT accounting.auto_reconcile($1, $2) AS n', [c.tenantId, idParam(req)], db), c);
      return { reconciled: res.rows[0]!.n };
    });

    r.get('/v2/banks/movements', { preHandler: requirePerm('banks:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const qp = req.query as Record<string, string | undefined>;
      const accountId = parseInt(qp.account_id ?? '', 10);
      if (!Number.isFinite(accountId)) throw new ValidationError('Indica la cuenta bancaria');
      const params: unknown[] = [tenantId, accountId];
      let where = 'm.tenant_id = $1 AND m.bank_account_id = $2';
      if (qp.status) { params.push(qp.status); where += ` AND m.status = $${params.length}`; }
      if (qp.from) { params.push(qp.from); where += ` AND m.movement_date >= $${params.length}`; }
      if (qp.to) { params.push(qp.to); where += ` AND m.movement_date <= $${params.length}`; }
      if (qp.q) { params.push(`%${qp.q}%`); where += ` AND (m.description ILIKE $${params.length} OR m.reference ILIKE $${params.length})`; }
      const limit = intParam(qp.limit, 500, 5000);
      const res = await q(`
        SELECT m.id, m.movement_date, m.reference, m.bank_code, m.description, m.debit, m.credit, m.balance, m.status, m.ignore_reason,
               l.kind AS link_kind, l.created_payment, l.created_entry,
               CASE WHEN p.id IS NOT NULL THEN CASE p.kind WHEN 'cobro' THEN 'Cobro C-' ELSE 'Pago P-' END || lpad(p.number::text, 5, '0') || ' · ' || p.party_name
                    WHEN e.id IS NOT NULL THEN 'Asiento #' || lpad(e.entry_number::text, 6, '0') || ' · ' || e.concept END AS link_label,
               coalesce(p.entry_id, e.id) AS link_entry_id
          FROM accounting.bank_movements m
          LEFT JOIN accounting.bank_links l ON l.movement_id = m.id
          LEFT JOIN accounting.payments p ON p.id = l.payment_id
          LEFT JOIN accounting.journal_lines jl ON jl.id = l.journal_line_id
          LEFT JOIN accounting.journal_entries e ON e.id = jl.entry_id
         WHERE ${where}
         ORDER BY m.movement_date DESC, m.id DESC LIMIT ${limit}`, params);
      return { items: res.rows };
    });

    r.get('/v2/banks/movements/:id/candidates', { preHandler: requirePerm('banks:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const res = await q('SELECT * FROM accounting.bank_candidates($1, $2)', [tenantId, idParam(req)]);
      return { items: res.rows };
    });

    r.post('/v2/banks/movements/:id/reconcile', { preHandler: requirePerm('banks:manage') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({
        kind: z.enum(['payment', 'journal_line', 'document', 'entry']),
        target_id: z.number().int().positive().nullable().optional(),
        counter_account_id: z.number().int().positive().nullable().optional(),
        description: z.string().max(300).nullable().optional(),
      }), req.body);
      if (b.kind !== 'entry' && !b.target_id) throw new ValidationError('Indica con qué se concilia');
      const res = await tx(db => q<{ id: number }>('SELECT accounting.reconcile_movement($1, $2, $3, $4, $5, $6) AS id',
        [c.tenantId, idParam(req), b.kind, b.target_id ?? null, b.counter_account_id ?? null, b.description ?? null], db), c);
      return { link_id: res.rows[0]!.id };
    });

    r.post('/v2/banks/movements/:id/unreconcile', { preHandler: requirePerm('banks:manage') }, async (req) => {
      const c = ctx(req);
      await tx(db => q('SELECT accounting.unreconcile_movement($1, $2)', [c.tenantId, idParam(req)], db), c);
      return { success: true };
    });

    r.post('/v2/banks/movements/:id/ignore', { preHandler: requirePerm('banks:manage') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({ reason: z.string().trim().min(3, 'Indica el motivo') }), req.body);
      const res = await q(`UPDATE accounting.bank_movements SET status = 'ignorado', ignore_reason = $3
                            WHERE id = $1 AND tenant_id = $2 AND status = 'pendiente' RETURNING id`, [idParam(req), c.tenantId, b.reason]);
      if (!res.rows.length) throw new ValidationError('Solo se ignoran movimientos pendientes');
      return { success: true };
    });

    // ── Conciliación bancaria a una fecha (saldo banco vs libros) ────────────
    r.get('/v2/banks/accounts/:id/reconciliation', { preHandler: requirePerm('banks:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const id = idParam(req);
      const asOf = (req.query as Record<string, string>).as_of ?? new Date().toISOString().slice(0, 10);
      const acc = await q<{ ledger_account_id: number; bank_name: string; account_number: string }>(
        'SELECT ledger_account_id, bank_name, account_number FROM accounting.bank_accounts WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
      if (!acc.rows.length) throw new ValidationError('Cuenta bancaria no encontrada');
      const ledgerId = acc.rows[0]!.ledger_account_id;
      const [bank, books, inBankOnly, inBooksOnly] = await Promise.all([
        q<{ balance: number | null; date: string | null }>(`
          SELECT balance, movement_date AS date FROM accounting.bank_movements
           WHERE bank_account_id = $1 AND movement_date <= $2 AND balance IS NOT NULL ORDER BY movement_date DESC, id DESC LIMIT 1`, [id, asOf]),
        q<{ b: number }>('SELECT accounting.ledger_balance($1, $2, $3) AS b', [tenantId, ledgerId, asOf]),
        q(`SELECT id, movement_date, reference, description, debit, credit FROM accounting.bank_movements
            WHERE bank_account_id = $1 AND movement_date <= $2 AND status = 'pendiente' ORDER BY movement_date`, [id, asOf]),
        q(`SELECT l.id, e.entry_date, e.entry_number, e.concept, l.description, l.debit, l.credit
             FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id = l.entry_id
            WHERE l.account_id = $1 AND e.status <> 'borrador' AND e.entry_date <= $2
              AND NOT EXISTS (SELECT 1 FROM accounting.bank_links bl WHERE bl.journal_line_id = l.id)
              AND NOT EXISTS (SELECT 1 FROM accounting.payments p JOIN accounting.bank_links bl ON bl.payment_id = p.id WHERE p.entry_id = e.id)
              -- reversiones y anulados se compensan entre sí: no son partidas en tránsito
              AND e.status IN ('contabilizado', 'revisado') AND e.entry_type <> 'reversion'
            ORDER BY e.entry_date, e.entry_number`, [ledgerId, asOf]),
      ]);
      // Desde el banco: + lo que entró y no está en libros (créditos pendientes) − lo que salió y no está en libros
      const bankBalance = bank.rows[0]?.balance ?? null;
      const pendingBank = (inBankOnly.rows as Array<{ debit: number; credit: number }>).reduce((s, m) => s + m.credit - m.debit, 0);
      const pendingBooks = (inBooksOnly.rows as Array<{ debit: number; credit: number }>).reduce((s, l) => s + l.debit - l.credit, 0);
      const bookBalance = books.rows[0]!.b;
      const adjustedBank = bankBalance === null ? null : Math.round((bankBalance + pendingBooks) * 100) / 100;
      const adjustedBooks = Math.round((bookBalance + pendingBank) * 100) / 100;
      return {
        as_of: asOf, account: acc.rows[0], bank_balance: bankBalance, bank_balance_date: bank.rows[0]?.date ?? null,
        book_balance: bookBalance, in_bank_only: inBankOnly.rows, in_books_only: inBooksOnly.rows,
        adjusted_bank: adjustedBank, adjusted_books: adjustedBooks,
        difference: adjustedBank === null ? null : Math.round((adjustedBank - adjustedBooks) * 100) / 100,
      };
    });

    // ── Disponibilidad ───────────────────────────────────────────────────────
    r.get('/v2/banks/availability', { preHandler: requirePerm('banks:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const accounts = await q<{ statement_balance: number | null; ledger_balance: number; is_active: boolean }>(
        `${ACCOUNT_SELECT} WHERE b.tenant_id = $1 AND b.is_active ORDER BY b.bank_name`, [tenantId]);
      const reserve = await q<{ amount: number; notes: string | null }>('SELECT amount, notes FROM accounting.bank_reserve WHERE tenant_id = $1', [tenantId]);
      const payables = await q<{ total: number; due7: number }>(`
        SELECT coalesce(sum(balance), 0) AS total,
               coalesce(sum(balance) FILTER (WHERE due_date <= CURRENT_DATE + 7), 0) AS due7
          FROM accounting.document_balances WHERE tenant_id = $1 AND kind = 'cxp' AND status = 'vigente' AND balance > 0`, [tenantId]);
      const receivables = await q<{ total: number; due7: number }>(`
        SELECT coalesce(sum(balance), 0) AS total,
               coalesce(sum(balance) FILTER (WHERE due_date <= CURRENT_DATE + 7), 0) AS due7
          FROM accounting.document_balances WHERE tenant_id = $1 AND kind = 'cxc' AND status = 'vigente' AND balance > 0`, [tenantId]);
      const banks = accounts.rows.reduce((s, a) => s + (a.statement_balance ?? a.ledger_balance), 0);
      const res = reserve.rows[0]?.amount ?? 0;
      const pay = payables.rows[0]!;
      return {
        accounts: accounts.rows, banks: Math.round(banks * 100) / 100, reserve: res, reserve_notes: reserve.rows[0]?.notes ?? null,
        payables: pay.total, payables_due_7: pay.due7, receivables: receivables.rows[0]!.total, receivables_due_7: receivables.rows[0]!.due7,
        available: Math.round((banks - res - pay.total) * 100) / 100,
      };
    });

    r.put('/v2/banks/reserve', { preHandler: requirePerm('banks:manage') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({ amount: z.number().min(0), notes: z.string().max(300).nullable().optional() }), req.body);
      await q(`INSERT INTO accounting.bank_reserve (tenant_id, amount, notes, updated_at, updated_by) VALUES ($1, $2, $3, NOW(), $4)
               ON CONFLICT (tenant_id) DO UPDATE SET amount = $2, notes = $3, updated_at = NOW(), updated_by = $4`,
        [c.tenantId, b.amount, b.notes ?? null, c.userName]);
      return { success: true };
    });
  });
}
