-- =============================================================================
-- 008_statements_closing — Estados financieros y cierre del ejercicio (F3).
--
--  * Firmantes de los estados (representante legal, contador, auditor).
--  * accounts.cash_flow: clasificación para el estado de flujo de efectivo
--    (NULL = automática según tipo y corriente/no corriente).
--  * Cierre anual (nuevo; no existía en ChuchoWash): partida de cierre al
--    31/12 que salda las cuentas de resultados contra "Utilidad (pérdida) del
--    ejercicio", traslado opcional a utilidades acumuladas el 1/1 siguiente y
--    cierre de los 12 meses. Reabrir revierte ambas partidas.
--  * account_movements con p_exclude_closing: el estado de resultados de un
--    año cerrado sigue mostrando sus cifras (sin la partida de cierre).
-- =============================================================================

ALTER TABLE accounting.settings
  ADD COLUMN legal_rep_name     TEXT,
  ADD COLUMN legal_rep_title    TEXT DEFAULT 'Representante legal',
  ADD COLUMN accountant_name    TEXT,
  ADD COLUMN accountant_license TEXT,
  ADD COLUMN auditor_name       TEXT,
  ADD COLUMN auditor_license    TEXT;

ALTER TABLE accounting.accounts ADD COLUMN cash_flow TEXT
  CHECK (cash_flow IN ('efectivo', 'operacion', 'inversion', 'financiamiento'));
COMMENT ON COLUMN accounting.accounts.cash_flow IS
  'Estado de flujo de efectivo. NULL = automático: efectivo si es caja/banco, activo/pasivo corriente → operación, activo no corriente → inversión, pasivo no corriente y patrimonio → financiamiento.';

CREATE TABLE accounting.fiscal_years (
  tenant_id         BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  year              INT NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  status            TEXT NOT NULL CHECK (status IN ('abierto', 'cerrado')),
  result            NUMERIC(14,2),
  closing_entry_id  BIGINT REFERENCES accounting.journal_entries(id),
  transfer_entry_id BIGINT REFERENCES accounting.journal_entries(id),
  closed_at         TIMESTAMPTZ,
  closed_by         TEXT,
  reopened_at       TIMESTAMPTZ,
  reopened_by       TEXT,
  notes             TEXT,
  PRIMARY KEY (tenant_id, year)
);

CREATE OR REPLACE FUNCTION accounting.account_movements(p_tenant BIGINT, p_from DATE, p_to DATE, p_exclude_closing BOOLEAN)
RETURNS TABLE (account_id BIGINT, debit_before NUMERIC, credit_before NUMERIC, debit NUMERIC, credit NUMERIC)
LANGUAGE sql STABLE AS $$
  SELECT l.account_id,
         coalesce(sum(l.debit) FILTER (WHERE e.entry_date < p_from), 0),
         coalesce(sum(l.credit) FILTER (WHERE e.entry_date < p_from), 0),
         coalesce(sum(l.debit) FILTER (WHERE e.entry_date BETWEEN p_from AND p_to), 0),
         coalesce(sum(l.credit) FILTER (WHERE e.entry_date BETWEEN p_from AND p_to), 0)
  FROM accounting.journal_lines l
  JOIN accounting.journal_entries e ON e.id = l.entry_id
  WHERE e.tenant_id = p_tenant AND e.status <> 'borrador' AND e.entry_date <= p_to
    AND (NOT p_exclude_closing OR coalesce(e.event_type, '') NOT IN ('YEAR_CLOSING', 'YEAR_CLOSING_REVERSED', 'RESULT_TRANSFER', 'RESULT_TRANSFER_REVERSED'))
  GROUP BY l.account_id;
$$;

/** Revisión previa al cierre: resultado, cuentas a saldar y bloqueos. */
CREATE OR REPLACE FUNCTION accounting.year_close_preview(p_tenant BIGINT, p_year INT)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_from DATE := make_date(p_year, 1, 1);
  v_to   DATE := make_date(p_year, 12, 31);
  v_result NUMERIC(14,2);
  v_accounts INT;
  v_issues JSONB := '[]';
  v_n INT;
BEGIN
  SELECT coalesce(sum(l.credit - l.debit), 0), count(DISTINCT l.account_id)
    INTO v_result, v_accounts
  FROM accounting.journal_lines l
  JOIN accounting.journal_entries e ON e.id = l.entry_id
  JOIN accounting.accounts a ON a.id = l.account_id
  WHERE e.tenant_id = p_tenant AND e.status <> 'borrador' AND e.entry_date <= v_to AND a.affects_result;

  IF EXISTS (SELECT 1 FROM accounting.fiscal_years WHERE tenant_id = p_tenant AND year = p_year AND status = 'cerrado') THEN
    v_issues := v_issues || to_jsonb('El ejercicio ' || p_year || ' ya está cerrado');
  END IF;
  SELECT count(*) INTO v_n FROM accounting.journal_entries
   WHERE tenant_id = p_tenant AND status = 'borrador' AND entry_date BETWEEN v_from AND v_to;
  IF v_n > 0 THEN v_issues := v_issues || to_jsonb(v_n || ' partida(s) en borrador en el ejercicio'); END IF;
  -- Años anteriores con resultados sin cerrar
  IF EXISTS (
    SELECT 1 FROM (
      SELECT extract(year FROM e.entry_date)::INT AS y, sum(l.debit - l.credit) AS net
      FROM accounting.journal_lines l
      JOIN accounting.journal_entries e ON e.id = l.entry_id
      JOIN accounting.accounts a ON a.id = l.account_id
      WHERE e.tenant_id = p_tenant AND e.status <> 'borrador' AND e.entry_date < v_from AND a.affects_result
      GROUP BY 1
    ) t
    WHERE t.net <> 0
      AND NOT EXISTS (SELECT 1 FROM accounting.fiscal_years f WHERE f.tenant_id = p_tenant AND f.year = t.y AND f.status = 'cerrado')
  ) THEN
    v_issues := v_issues || to_jsonb('Hay ejercicios anteriores con resultados sin cerrar: ciérralos primero'::TEXT);
  END IF;
  IF NOT accounting.period_is_open(p_tenant, v_to) THEN
    v_issues := v_issues || to_jsonb('Diciembre está cerrado: reábrelo para registrar la partida de cierre'::TEXT);
  END IF;
  IF accounting.role_account_opt(p_tenant, 'current_year_result') IS NULL THEN
    v_issues := v_issues || to_jsonb('Falta asignar la cuenta «Utilidad (pérdida) del ejercicio» en Configuración contable'::TEXT);
  END IF;
  SELECT count(*) INTO v_n FROM accounting.document_postings
   WHERE tenant_id = p_tenant AND status = 'error' AND doc_date BETWEEN v_from AND v_to;
  IF v_n > 0 THEN
    v_issues := v_issues || to_jsonb(v_n || ' venta(s)/compra(s) del ejercicio sin contabilizar por error (Contabilidad → Ventas y compras)');
  END IF;
  RETURN jsonb_build_object('year', p_year, 'result', v_result, 'accounts', v_accounts, 'issues', v_issues);
END;
$$;

/**
 * Cierre del ejercicio: partida al 31/12 que deja en cero todas las cuentas de
 * resultados (acumuladas hasta esa fecha) contra el rol current_year_result.
 * Con p_transfer, al 1/1 siguiente traslada el resultado a retained_earnings.
 * Cierra los 12 meses del año.
 */
CREATE OR REPLACE FUNCTION accounting.close_year(p_tenant BIGINT, p_year INT, p_transfer BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_preview JSONB := accounting.year_close_preview(p_tenant, p_year);
  v_to      DATE := make_date(p_year, 12, 31);
  v_lines   JSONB;
  v_result  NUMERIC(14,2);
  v_close   BIGINT;
  v_transfer BIGINT;
  v_res_acc BIGINT;
BEGIN
  IF jsonb_array_length(v_preview->'issues') > 0 THEN
    RAISE EXCEPTION 'No se puede cerrar %: %', p_year, v_preview->'issues'->>0 USING ERRCODE = '22023';
  END IF;
  v_res_acc := accounting.role_account(p_tenant, 'current_year_result');

  SELECT jsonb_agg(jsonb_build_object('account_id', account_id, 'amount', -bal, 'description', 'Cierre ' || p_year) ORDER BY code),
         coalesce(sum(bal), 0)
    INTO v_lines, v_result
  FROM (
    SELECT l.account_id, a.code, sum(l.debit - l.credit) AS bal
    FROM accounting.journal_lines l
    JOIN accounting.journal_entries e ON e.id = l.entry_id
    JOIN accounting.accounts a ON a.id = l.account_id
    WHERE e.tenant_id = p_tenant AND e.status <> 'borrador' AND e.entry_date <= v_to AND a.affects_result
    GROUP BY l.account_id, a.code
    HAVING sum(l.debit - l.credit) <> 0
  ) t;
  -- v_result = Σ(debe − haber) de resultados: positivo = pérdida
  v_result := -v_result;

  IF v_lines IS NOT NULL THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_res_acc, 'amount', -v_result,
      'description', CASE WHEN v_result >= 0 THEN 'Utilidad del ejercicio ' ELSE 'Pérdida del ejercicio ' END || p_year));
    v_close := accounting.create_entry(p_tenant, v_to, 'YEAR_CLOSING', 'cierre', p_year::TEXT, 'Cierre ' || p_year,
      'Partida de cierre del ejercicio ' || p_year, accounting.amount_lines(v_lines));
  END IF;

  IF p_transfer AND v_result <> 0 THEN
    v_transfer := accounting.create_entry(p_tenant, make_date(p_year + 1, 1, 1), 'RESULT_TRANSFER', 'cierre', p_year::TEXT,
      'Traslado ' || p_year, 'Traslado del resultado del ejercicio ' || p_year || ' a utilidades acumuladas',
      accounting.amount_lines(jsonb_build_array(
        jsonb_build_object('account_id', v_res_acc, 'amount', v_result, 'description', 'Resultado ' || p_year),
        jsonb_build_object('account_id', accounting.role_account(p_tenant, 'retained_earnings'), 'amount', -v_result,
                           'description', 'Resultado ' || p_year))));
  END IF;

  INSERT INTO accounting.fiscal_years (tenant_id, year, status, result, closing_entry_id, transfer_entry_id, closed_at, closed_by)
  VALUES (p_tenant, p_year, 'cerrado', v_result, v_close, v_transfer, NOW(), accounting.ctx_user_name())
  ON CONFLICT (tenant_id, year) DO UPDATE SET status = 'cerrado', result = v_result, closing_entry_id = v_close,
    transfer_entry_id = v_transfer, closed_at = NOW(), closed_by = accounting.ctx_user_name();

  INSERT INTO accounting.periods (tenant_id, year, month, status, closed_at, closed_by, notes)
  SELECT p_tenant, p_year, m, 'cerrado', NOW(), accounting.ctx_user_name(), 'Cierre del ejercicio'
  FROM generate_series(1, 12) m
  ON CONFLICT (tenant_id, year, month) DO UPDATE SET status = 'cerrado', closed_at = NOW(), closed_by = accounting.ctx_user_name();

  RETURN jsonb_build_object('result', v_result, 'closing_entry_id', v_close, 'transfer_entry_id', v_transfer);
END;
$$;

/** Reabre un ejercicio: revierte traslado y cierre, y reabre diciembre. */
CREATE OR REPLACE FUNCTION accounting.reopen_year(p_tenant BIGINT, p_year INT, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  v accounting.fiscal_years%ROWTYPE;
BEGIN
  SELECT * INTO v FROM accounting.fiscal_years WHERE tenant_id = p_tenant AND year = p_year FOR UPDATE;
  IF NOT FOUND OR v.status <> 'cerrado' THEN RAISE EXCEPTION 'El ejercicio % no está cerrado', p_year USING ERRCODE = '22023'; END IF;
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'Indica el motivo de la reapertura' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM accounting.fiscal_years WHERE tenant_id = p_tenant AND year = p_year + 1 AND status = 'cerrado') THEN
    RAISE EXCEPTION 'Reabre primero el ejercicio %', p_year + 1 USING ERRCODE = '22023';
  END IF;
  UPDATE accounting.periods SET status = 'abierto', reopened_at = NOW(), reopened_by = accounting.ctx_user_name(), notes = btrim(p_reason)
   WHERE tenant_id = p_tenant AND year = p_year AND month = 12;
  IF v.transfer_entry_id IS NOT NULL THEN
    PERFORM accounting.reverse_entry(p_tenant, v.transfer_entry_id, p_reason, 'RESULT_TRANSFER_REVERSED');
  END IF;
  IF v.closing_entry_id IS NOT NULL THEN
    PERFORM accounting.reverse_entry(p_tenant, v.closing_entry_id, p_reason, 'YEAR_CLOSING_REVERSED');
  END IF;
  UPDATE accounting.fiscal_years SET status = 'abierto', closing_entry_id = NULL, transfer_entry_id = NULL,
         reopened_at = NOW(), reopened_by = accounting.ctx_user_name(), notes = btrim(p_reason)
   WHERE tenant_id = p_tenant AND year = p_year;
END;
$$;
