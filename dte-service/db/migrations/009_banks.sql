-- =============================================================================
-- 009_banks — Bancos y conciliación bancaria (F4). Portado de ChuchoWash
-- (0054/0055) y generalizado: cada empresa registra sus cuentas en cualquier
-- banco (BAC, Agrícola, Davivienda, Cuscatlán…), cada una ligada a una cuenta
-- contable de su catálogo.
--
--  * Estados de cuenta: el frontend lee el archivo (lector BAC portado de
--    Airbox/ChuchoWash, o un lector CSV configurable por cuenta) y envía los
--    movimientos; la base los deduplica por hash (fecha, referencia, montos,
--    descripción). Importar NO contabiliza nada.
--  * Conciliación genérica: cada movimiento del banco se enlaza con
--      - un cobro/pago ya registrado en esa cuenta bancaria,
--      - una línea del mayor de la cuenta bancaria (cualquier asiento),
--      - un cobro/pago NUEVO aplicado a documentos de CxC/CxP, o
--      - un asiento nuevo contra una cuenta (comisiones, intereses, traslados).
--    Deshacer revierte lo que la conciliación creó.
--  * Conciliación bancaria a una fecha: saldo según banco vs según libros con
--    partidas en tránsito.
-- =============================================================================

CREATE TABLE accounting.bank_accounts (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  bank_name         TEXT NOT NULL,
  account_number    TEXT NOT NULL,
  account_type      TEXT NOT NULL DEFAULT 'corriente' CHECK (account_type IN ('corriente', 'ahorro', 'otra')),
  currency          TEXT NOT NULL DEFAULT 'USD',
  ledger_account_id BIGINT NOT NULL REFERENCES accounting.accounts(id),
  statement_format  TEXT NOT NULL DEFAULT 'generic' CHECK (statement_format IN ('bac', 'generic')),
  csv_mapping       JSONB NOT NULL DEFAULT '{}',
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, account_number),
  UNIQUE (tenant_id, ledger_account_id)
);

CREATE TABLE accounting.bank_imports (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  bank_account_id  BIGINT NOT NULL REFERENCES accounting.bank_accounts(id),
  file_name        TEXT,
  period_from      DATE,
  period_to        DATE,
  opening_balance  NUMERIC(14,2),
  closing_balance  NUMERIC(14,2),
  rows_total       INT NOT NULL DEFAULT 0,
  rows_new         INT NOT NULL DEFAULT 0,
  totals_ok        BOOLEAN,
  created_by_name  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE accounting.bank_movements (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  bank_account_id BIGINT NOT NULL REFERENCES accounting.bank_accounts(id),
  import_id       BIGINT REFERENCES accounting.bank_imports(id),
  movement_date   DATE NOT NULL,
  reference       TEXT,
  bank_code       TEXT,
  description     TEXT,
  debit           NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),    -- sale del banco
  credit          NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),   -- entra al banco
  balance         NUMERIC(14,2),
  dedup_hash      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'conciliado', 'ignorado')),
  ignore_reason   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bank_account_id, dedup_hash),
  CONSTRAINT bank_movements_one_side CHECK ((debit = 0) <> (credit = 0))
);
CREATE INDEX idx_bank_movements_account_date ON accounting.bank_movements(bank_account_id, movement_date);

CREATE TABLE accounting.bank_links (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  movement_id    BIGINT NOT NULL REFERENCES accounting.bank_movements(id),
  kind           TEXT NOT NULL CHECK (kind IN ('payment', 'journal_line')),
  payment_id     BIGINT REFERENCES accounting.payments(id),
  journal_line_id BIGINT REFERENCES accounting.journal_lines(id),
  created_payment BOOLEAN NOT NULL DEFAULT false,   -- el cobro/pago lo creó la conciliación
  created_entry   BIGINT REFERENCES accounting.journal_entries(id),   -- asiento creado desde el movimiento
  created_by_name TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bank_links_target CHECK ((kind = 'payment') = (payment_id IS NOT NULL) AND (kind = 'journal_line') = (journal_line_id IS NOT NULL))
);
CREATE UNIQUE INDEX bank_links_movement ON accounting.bank_links(movement_id);
CREATE UNIQUE INDEX bank_links_payment ON accounting.bank_links(payment_id) WHERE payment_id IS NOT NULL;
CREATE UNIQUE INDEX bank_links_line ON accounting.bank_links(journal_line_id) WHERE journal_line_id IS NOT NULL;

ALTER TABLE accounting.payments ADD COLUMN bank_movement_id BIGINT REFERENCES accounting.bank_movements(id);

-- Reserva manual para la disponibilidad (fondos comprometidos)
CREATE TABLE accounting.bank_reserve (
  tenant_id  BIGINT PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  amount     NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  notes      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT
);

/** Número de cuenta comparable: solo dígitos. */
CREATE OR REPLACE FUNCTION accounting.digits(p TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(coalesce(p, ''), '\D', '', 'g');
$$;

/**
 * Importa movimientos ya leídos del archivo. p_rows: [{date, reference, code,
 * description, debit, credit, balance}]. Deduplica por hash. Si el archivo
 * trae número de cuenta, debe coincidir con la cuenta elegida.
 */
CREATE OR REPLACE FUNCTION accounting.import_bank_statement(
  p_tenant BIGINT, p_account BIGINT, p_file_name TEXT, p_file_account TEXT,
  p_opening NUMERIC, p_closing NUMERIC, p_totals_ok BOOLEAN, p_rows JSONB
)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_acc    accounting.bank_accounts%ROWTYPE;
  v_import BIGINT;
  v_new    INT;
  v_total  INT := jsonb_array_length(coalesce(p_rows, '[]'));
BEGIN
  SELECT * INTO v_acc FROM accounting.bank_accounts WHERE id = p_account AND tenant_id = p_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cuenta bancaria no encontrada' USING ERRCODE = 'P0002'; END IF;
  IF NULLIF(accounting.digits(p_file_account), '') IS NOT NULL
     AND right(accounting.digits(p_file_account), 6) <> right(accounting.digits(v_acc.account_number), 6) THEN
    RAISE EXCEPTION 'El archivo es de la cuenta % y elegiste la cuenta % (%)', p_file_account, v_acc.account_number, v_acc.bank_name
      USING ERRCODE = '22023';
  END IF;
  IF v_total = 0 THEN RAISE EXCEPTION 'El archivo no tiene movimientos' USING ERRCODE = '22023'; END IF;

  INSERT INTO accounting.bank_imports (tenant_id, bank_account_id, file_name, period_from, period_to, opening_balance,
                                       closing_balance, rows_total, totals_ok, created_by_name)
  SELECT p_tenant, p_account, p_file_name, min((r->>'date')::DATE), max((r->>'date')::DATE), p_opening, p_closing, v_total,
         p_totals_ok, accounting.ctx_user_name()
  FROM jsonb_array_elements(p_rows) r
  RETURNING id INTO v_import;

  WITH ins AS (
    INSERT INTO accounting.bank_movements (tenant_id, bank_account_id, import_id, movement_date, reference, bank_code, description,
                                           debit, credit, balance, dedup_hash)
    SELECT p_tenant, p_account, v_import, (r->>'date')::DATE, NULLIF(btrim(r->>'reference'), ''), NULLIF(btrim(r->>'code'), ''),
           NULLIF(btrim(r->>'description'), ''),
           round(coalesce(NULLIF(r->>'debit', '')::NUMERIC, 0), 2), round(coalesce(NULLIF(r->>'credit', '')::NUMERIC, 0), 2),
           NULLIF(r->>'balance', '')::NUMERIC,
           encode(sha256(convert_to(concat_ws('|', p_account, r->>'date', btrim(coalesce(r->>'reference', '')),
             round(coalesce(NULLIF(r->>'debit', '')::NUMERIC, 0), 2), round(coalesce(NULLIF(r->>'credit', '')::NUMERIC, 0), 2),
             upper(regexp_replace(btrim(coalesce(r->>'description', '')), '\s+', ' ', 'g')),
             -- dos movimientos idénticos el mismo día: los distingue su orden dentro del archivo
             (SELECT count(*) FROM jsonb_array_elements(p_rows) WITH ORDINALITY x(rr, o)
               WHERE o < ord AND rr->>'date' = r->>'date' AND coalesce(rr->>'reference', '') = coalesce(r->>'reference', '')
                 AND coalesce(rr->>'debit', '') = coalesce(r->>'debit', '') AND coalesce(rr->>'credit', '') = coalesce(r->>'credit', '')
                 AND coalesce(rr->>'description', '') = coalesce(r->>'description', ''))
           ), 'UTF8')), 'hex')
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(r, ord)
    WHERE round(coalesce(NULLIF(r->>'debit', '')::NUMERIC, 0), 2) <> 0 OR round(coalesce(NULLIF(r->>'credit', '')::NUMERIC, 0), 2) <> 0
    ON CONFLICT (bank_account_id, dedup_hash) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_new FROM ins;

  UPDATE accounting.bank_imports SET rows_new = v_new WHERE id = v_import;
  RETURN jsonb_build_object('import_id', v_import, 'rows', v_total, 'new', v_new, 'duplicates', v_total - v_new);
END;
$$;

/** Saldo contable de una cuenta (debe − haber) a una fecha. */
CREATE OR REPLACE FUNCTION accounting.ledger_balance(p_tenant BIGINT, p_account BIGINT, p_date DATE)
RETURNS NUMERIC LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(l.debit - l.credit), 0)
  FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id = l.entry_id
  WHERE e.tenant_id = p_tenant AND l.account_id = p_account AND e.status <> 'borrador' AND e.entry_date <= p_date;
$$;

/**
 * Candidatos para conciliar un movimiento (mismo monto y sentido, ±10 días):
 * cobros/pagos de esa cuenta, líneas del mayor de la cuenta bancaria y
 * documentos de CxC/CxP con ese saldo. Puntaje: exacto en fecha primero.
 */
CREATE OR REPLACE FUNCTION accounting.bank_candidates(p_tenant BIGINT, p_movement BIGINT)
RETURNS TABLE (kind TEXT, target_id BIGINT, target_date DATE, label TEXT, party_name TEXT, amount NUMERIC, days INT)
LANGUAGE sql STABLE AS $$
  WITH m AS (
    SELECT bm.*, ba.ledger_account_id, (bm.credit > 0) AS is_in, greatest(bm.debit, bm.credit) AS amt
    FROM accounting.bank_movements bm JOIN accounting.bank_accounts ba ON ba.id = bm.bank_account_id
    WHERE bm.id = p_movement AND bm.tenant_id = p_tenant
  )
  SELECT 'payment', p.id, p.payment_date,
         CASE p.kind WHEN 'cobro' THEN 'Cobro C-' ELSE 'Pago P-' END || lpad(p.number::TEXT, 5, '0') || coalesce(' · ' || p.reference, ''),
         p.party_name, p.amount, abs(p.payment_date - m.movement_date)
  FROM m JOIN accounting.payments p ON p.tenant_id = p_tenant AND p.status = 'vigente'
   AND p.fund_account_id = m.ledger_account_id AND p.amount = m.amt
   AND p.kind = CASE WHEN m.is_in THEN 'cobro' ELSE 'pago' END
   AND abs(p.payment_date - m.movement_date) <= 10
   AND NOT EXISTS (SELECT 1 FROM accounting.bank_links bl WHERE bl.payment_id = p.id)
  UNION ALL
  SELECT 'journal_line', l.id, e.entry_date, 'Asiento #' || lpad(e.entry_number::TEXT, 6, '0') || ' · ' || e.concept,
         NULL, greatest(l.debit, l.credit), abs(e.entry_date - m.movement_date)
  FROM m JOIN accounting.journal_lines l ON l.account_id = m.ledger_account_id
   AND (CASE WHEN m.is_in THEN l.debit ELSE l.credit END) = m.amt
  JOIN accounting.journal_entries e ON e.id = l.entry_id AND e.status IN ('contabilizado', 'revisado')
   AND abs(e.entry_date - m.movement_date) <= 10
  WHERE NOT EXISTS (SELECT 1 FROM accounting.bank_links bl WHERE bl.journal_line_id = l.id)
    -- las líneas de un cobro/pago se concilian por el cobro/pago
    AND NOT EXISTS (SELECT 1 FROM accounting.payments p WHERE p.entry_id = e.id)
  UNION ALL
  SELECT 'document', d.id, d.doc_date, coalesce(d.doc_number, 'Documento') || ' (' || CASE d.kind WHEN 'cxc' THEN 'por cobrar' ELSE 'por pagar' END || ')',
         d.party_name, d.balance, abs(d.due_date - m.movement_date)
  FROM m JOIN accounting.document_balances d ON d.tenant_id = p_tenant AND d.status = 'vigente'
   AND d.kind = CASE WHEN m.is_in THEN 'cxc' ELSE 'cxp' END AND d.balance = m.amt
  ORDER BY 7, 1 DESC
  LIMIT 30;
$$;

/**
 * Concilia un movimiento.
 *  p_kind = 'payment'      → enlaza un cobro/pago existente (p_target = payment id)
 *  p_kind = 'journal_line' → enlaza una línea del mayor de la cuenta bancaria
 *  p_kind = 'document'     → crea un cobro/pago aplicado a ese documento y lo enlaza
 *  p_kind = 'entry'        → crea un asiento banco vs p_counter_account y lo enlaza
 */
CREATE OR REPLACE FUNCTION accounting.reconcile_movement(
  p_tenant BIGINT, p_movement BIGINT, p_kind TEXT, p_target BIGINT, p_counter_account BIGINT, p_description TEXT
)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  m        accounting.bank_movements%ROWTYPE;
  v_ledger BIGINT;
  v_amt    NUMERIC(14,2);
  v_in     BOOLEAN;
  v_pay    accounting.payments%ROWTYPE;
  v_line   RECORD;
  v_doc    accounting.document_balances%ROWTYPE;
  v_link   BIGINT;
  v_payment BIGINT;
  v_entry  BIGINT;
  v_bank   accounting.bank_accounts%ROWTYPE;
BEGIN
  SELECT * INTO m FROM accounting.bank_movements WHERE id = p_movement AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Movimiento no encontrado' USING ERRCODE = 'P0002'; END IF;
  IF m.status <> 'pendiente' THEN RAISE EXCEPTION 'El movimiento ya está conciliado o ignorado' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_bank FROM accounting.bank_accounts WHERE id = m.bank_account_id;
  v_ledger := v_bank.ledger_account_id;
  v_amt := greatest(m.debit, m.credit);
  v_in := m.credit > 0;

  IF p_kind = 'payment' THEN
    SELECT * INTO v_pay FROM accounting.payments WHERE id = p_target AND tenant_id = p_tenant AND status = 'vigente';
    IF NOT FOUND THEN RAISE EXCEPTION 'Cobro/pago no encontrado' USING ERRCODE = 'P0002'; END IF;
    IF v_pay.fund_account_id IS DISTINCT FROM v_ledger OR v_pay.amount <> v_amt
       OR v_pay.kind <> (CASE WHEN v_in THEN 'cobro' ELSE 'pago' END) THEN
      RAISE EXCEPTION 'El % no coincide con el movimiento (cuenta, monto o sentido)', v_pay.kind USING ERRCODE = '22023';
    END IF;
    INSERT INTO accounting.bank_links (tenant_id, movement_id, kind, payment_id, created_by_name)
    VALUES (p_tenant, m.id, 'payment', v_pay.id, accounting.ctx_user_name()) RETURNING id INTO v_link;

  ELSIF p_kind = 'journal_line' THEN
    SELECT l.*, e.status AS entry_status INTO v_line FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id = l.entry_id
     WHERE l.id = p_target AND l.tenant_id = p_tenant;
    IF NOT FOUND OR v_line.entry_status NOT IN ('contabilizado', 'revisado') THEN
      RAISE EXCEPTION 'Línea de asiento no encontrada' USING ERRCODE = 'P0002';
    END IF;
    IF v_line.account_id <> v_ledger OR (CASE WHEN v_in THEN v_line.debit ELSE v_line.credit END) <> v_amt THEN
      RAISE EXCEPTION 'La línea no coincide con el movimiento (cuenta, monto o sentido)' USING ERRCODE = '22023';
    END IF;
    INSERT INTO accounting.bank_links (tenant_id, movement_id, kind, journal_line_id, created_by_name)
    VALUES (p_tenant, m.id, 'journal_line', p_target, accounting.ctx_user_name()) RETURNING id INTO v_link;

  ELSIF p_kind = 'document' THEN
    SELECT * INTO v_doc FROM accounting.document_balances WHERE id = p_target AND tenant_id = p_tenant;
    IF NOT FOUND OR v_doc.status <> 'vigente' THEN RAISE EXCEPTION 'Documento no encontrado' USING ERRCODE = 'P0002'; END IF;
    IF v_doc.kind <> (CASE WHEN v_in THEN 'cxc' ELSE 'cxp' END) THEN
      RAISE EXCEPTION 'Un % no se concilia con un documento %', CASE WHEN v_in THEN 'depósito' ELSE 'cargo' END,
        CASE v_doc.kind WHEN 'cxc' THEN 'por cobrar' ELSE 'por pagar' END USING ERRCODE = '22023';
    END IF;
    v_payment := accounting.register_payment(p_tenant, CASE WHEN v_in THEN 'cobro' ELSE 'pago' END, m.movement_date, v_doc.party_key,
      CASE WHEN m.bank_code ILIKE 'CH%' OR m.description ILIKE '%cheque%' THEN 'cheque' ELSE 'transferencia' END,
      v_ledger, v_amt, jsonb_build_array(jsonb_build_object('document_id', v_doc.id, 'amount', least(v_amt, v_doc.balance))),
      coalesce(m.reference, m.description), 'Conciliación bancaria');
    UPDATE accounting.payments SET bank_movement_id = m.id WHERE id = v_payment;
    INSERT INTO accounting.bank_links (tenant_id, movement_id, kind, payment_id, created_payment, created_by_name)
    VALUES (p_tenant, m.id, 'payment', v_payment, true, accounting.ctx_user_name()) RETURNING id INTO v_link;

  ELSIF p_kind = 'entry' THEN
    IF p_counter_account IS NULL THEN RAISE EXCEPTION 'Indica la cuenta contrapartida' USING ERRCODE = '22023'; END IF;
    v_entry := accounting.create_entry(p_tenant, m.movement_date, 'BANK_MOVEMENT', 'bancos', m.id::TEXT,
      v_bank.bank_name || ' ' || coalesce(m.reference, ''),
      coalesce(NULLIF(btrim(p_description), ''), m.description, 'Movimiento bancario'),
      accounting.amount_lines(jsonb_build_array(
        jsonb_build_object('account_id', v_ledger, 'amount', CASE WHEN v_in THEN v_amt ELSE -v_amt END,
                           'description', m.description, 'reference', m.reference),
        jsonb_build_object('account_id', p_counter_account, 'amount', CASE WHEN v_in THEN -v_amt ELSE v_amt END,
                           'description', coalesce(NULLIF(btrim(p_description), ''), m.description)))));
    SELECT id INTO v_line FROM accounting.journal_lines WHERE entry_id = v_entry AND account_id = v_ledger LIMIT 1;
    INSERT INTO accounting.bank_links (tenant_id, movement_id, kind, journal_line_id, created_entry, created_by_name)
    VALUES (p_tenant, m.id, 'journal_line', v_line.id, v_entry, accounting.ctx_user_name()) RETURNING id INTO v_link;
  ELSE
    RAISE EXCEPTION 'Tipo de conciliación inválido' USING ERRCODE = '22023';
  END IF;

  UPDATE accounting.bank_movements SET status = 'conciliado' WHERE id = m.id;
  RETURN v_link;
END;
$$;

/** Deshace una conciliación; anula lo que la conciliación creó (cobro/pago o asiento). */
CREATE OR REPLACE FUNCTION accounting.unreconcile_movement(p_tenant BIGINT, p_movement BIGINT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  v accounting.bank_links%ROWTYPE;
BEGIN
  SELECT * INTO v FROM accounting.bank_links WHERE movement_id = p_movement AND tenant_id = p_tenant;
  IF FOUND THEN
    DELETE FROM accounting.bank_links WHERE id = v.id;
    IF v.created_payment THEN
      PERFORM accounting.void_payment(p_tenant, v.payment_id, 'Conciliación bancaria deshecha');
    END IF;
    IF v.created_entry IS NOT NULL THEN
      PERFORM accounting.reverse_entry(p_tenant, v.created_entry, 'Conciliación bancaria deshecha', 'BANK_MOVEMENT_VOIDED');
    END IF;
  END IF;
  UPDATE accounting.bank_movements SET status = 'pendiente', ignore_reason = NULL WHERE id = p_movement AND tenant_id = p_tenant;
END;
$$;

/** Concilia automáticamente los movimientos pendientes que tienen UN solo candidato exacto (cobro/pago o línea, ±3 días). */
CREATE OR REPLACE FUNCTION accounting.auto_reconcile(p_tenant BIGINT, p_account BIGINT)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
  r RECORD;
  c RECORD;
  v_n INT := 0;
  v_cnt INT;
BEGIN
  FOR r IN SELECT id FROM accounting.bank_movements
           WHERE tenant_id = p_tenant AND bank_account_id = p_account AND status = 'pendiente' ORDER BY movement_date, id LOOP
    SELECT count(*) INTO v_cnt FROM accounting.bank_candidates(p_tenant, r.id) x WHERE x.kind IN ('payment', 'journal_line') AND x.days <= 3;
    IF v_cnt <> 1 THEN CONTINUE; END IF;
    SELECT * INTO c FROM accounting.bank_candidates(p_tenant, r.id) x WHERE x.kind IN ('payment', 'journal_line') AND x.days <= 3;
    -- el mismo destino podría ser el único candidato de dos movimientos: el segundo falla por el índice único y se salta
    BEGIN
      PERFORM accounting.reconcile_movement(p_tenant, r.id, c.kind, c.target_id, NULL, NULL);
      v_n := v_n + 1;
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
  END LOOP;
  RETURN v_n;
END;
$$;
