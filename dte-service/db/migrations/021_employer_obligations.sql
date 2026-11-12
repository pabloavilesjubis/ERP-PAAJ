-- =============================================================================
-- 021_employer_obligations — Posición fiscal → Obligaciones patronales.
-- Portado de ChuchoWash (0068), por empresa (tenant_id) y conectado a la
-- contabilidad (los pagos al ISSS y a las AFP generan su asiento).
--
-- Para un mes:
--  * Empleados: ISSS (laboral + patronal), INSAFORP, AFP (laboral + patronal,
--    por AFP) y renta retenida. "real" suma las planillas emitidas del mes
--    (por fin de período) y las liquidaciones; "estimado" las calcula con el
--    salario de los empleados activos (renta fija) + la renta variable que el
--    usuario escribe por empleado (horas extra, comisiones, bonos), con los
--    mismos parámetros y la tabla de renta de Planillas.
--  * Honorarios: renta retenida en el libro de compras del mes + honorarios
--    estimados (10 % domiciliados, Art. 156 LISR; 20 % no domiciliados,
--    Art. 158 LISR; editables en Planillas → Configuración).
--  * Consolidación por pagador: Hacienda F-07 (IVA) y F-14 (anticipo +
--    retenciones), ISSS (+ INSAFORP) y cada AFP, con lo ya pagado y el
--    vencimiento aproximado (10.º día hábil del mes siguiente).
--  Lo que el usuario escribe para un mes se guarda en accounting.obligation_estimates.
-- =============================================================================

ALTER TABLE payroll.settings
  ADD COLUMN IF NOT EXISTS fee_withholding_rate NUMERIC(6,4) NOT NULL DEFAULT 0.10 CHECK (fee_withholding_rate BETWEEN 0 AND 1),
  ADD COLUMN IF NOT EXISTS fee_nonresident_rate NUMERIC(6,4) NOT NULL DEFAULT 0.20 CHECK (fee_nonresident_rate BETWEEN 0 AND 1);
COMMENT ON COLUMN payroll.settings.fee_withholding_rate IS 'Renta retenida a honorarios / servicios de personas naturales domiciliadas (Art. 156 LISR)';
COMMENT ON COLUMN payroll.settings.fee_nonresident_rate IS 'Renta retenida a pagos a no domiciliados (Art. 158 LISR)';

CREATE TABLE IF NOT EXISTS accounting.obligation_estimates (
  tenant_id  BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  period     DATE NOT NULL CHECK (period = date_trunc('month', period)::DATE),
  -- { "mode": "real" | "estimado",
  --   "variable": { "<employee_id>": { "amount": 0, "note": "" } },
  --   "fees": [ { "name": "", "kind": "domiciliado" | "no_domiciliado", "amount": 0, "note": "" } ] }
  inputs     JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT,
  PRIMARY KEY (tenant_id, period)
);

-- Pagos al ISSS y a las AFP (Hacienda se paga en accounting.fiscal_payments)
CREATE TABLE IF NOT EXISTS accounting.obligation_payments (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  payee_key       TEXT NOT NULL CHECK (payee_key IN ('isss', 'afp_confia', 'afp_crecer', 'afp_sin')),
  period          DATE NOT NULL CHECK (period = date_trunc('month', period)::DATE),
  payment_date    DATE NOT NULL,
  amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  fund_account_id BIGINT NOT NULL REFERENCES accounting.accounts(id),
  reference       TEXT,
  status          TEXT NOT NULL DEFAULT 'vigente' CHECK (status IN ('vigente', 'anulado')),
  entry_id        BIGINT REFERENCES accounting.journal_entries(id),
  created_by_name TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  void_reason     TEXT
);
CREATE INDEX IF NOT EXISTS idx_obligation_payments ON accounting.obligation_payments(tenant_id, period);

/** El n-ésimo día hábil (lun–vie) de un mes; no descuenta asuetos, es aproximado. */
CREATE OR REPLACE FUNCTION accounting.nth_business_day(p_month DATE, p_n INT)
RETURNS DATE LANGUAGE sql IMMUTABLE AS $$
  SELECT d::DATE FROM generate_series(date_trunc('month', p_month), date_trunc('month', p_month) + INTERVAL '1 month - 1 day', INTERVAL '1 day') d
  WHERE extract(isodow FROM d) < 6
  ORDER BY d OFFSET greatest(p_n - 1, 0) LIMIT 1
$$;

/**
 * Obligaciones patronales de un mes (ver encabezado). p_inputs reemplaza lo
 * guardado (la página recalcula antes de guardar). p_with_employees: el
 * detalle por empleado (salarios) solo para quien puede ver planillas.
 */
CREATE OR REPLACE FUNCTION accounting.employer_obligations(p_tenant BIGINT, p_month DATE, p_inputs JSONB DEFAULT NULL, p_with_employees BOOLEAN DEFAULT true)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_month    DATE := date_trunc('month', p_month)::DATE;
  v_end      DATE := (date_trunc('month', p_month) + INTERVAL '1 month - 1 day')::DATE;
  v_next     DATE := (date_trunc('month', p_month) + INTERVAL '1 month')::DATE;
  s          payroll.settings%ROWTYPE;
  v_saved    accounting.obligation_estimates%ROWTYPE;
  v_inputs   JSONB;
  v_emitted  INT;
  v_mode     TEXT;
  v_emps     JSONB;
  v_fees     JSONB;
  v_manual   JSONB;
  v_fiscal   JSONB;
  v_raw      JSONB;
  v_rate     NUMERIC;
  tot        RECORD;
  v_isr_fees NUMERIC;
  v_anticipo NUMERIC;
  v_f07      NUMERIC;
  v_paid07   NUMERIC := 0;
  v_paid14   NUMERIC := 0;
  v_due      DATE := accounting.nth_business_day(v_next, 10);
  v_payees   JSONB;
BEGIN
  IF p_month IS NULL THEN RAISE EXCEPTION 'Indica el mes' USING ERRCODE = '22023'; END IF;
  SELECT * INTO s FROM payroll.settings WHERE tenant_id = p_tenant;
  IF NOT FOUND THEN
    -- Sin planillas configuradas: parámetros de ley por defecto
    s.tenant_id := p_tenant; s.isss_employee_rate := 0.03; s.isss_employer_rate := 0.075; s.isss_cap := 1000;
    s.afp_employee_rate := 0.0725; s.afp_employer_rate := 0.0875; s.afp_cap := NULL; s.insaforp_applies := false; s.insaforp_rate := 0.01;
    s.fee_withholding_rate := 0.10; s.fee_nonresident_rate := 0.20;
  END IF;
  SELECT * INTO v_saved FROM accounting.obligation_estimates WHERE tenant_id = p_tenant AND period = v_month;
  v_inputs := coalesce(p_inputs, v_saved.inputs, '{}');

  SELECT count(*) INTO v_emitted FROM payroll.payrolls
  WHERE tenant_id = p_tenant AND status = 'emitida' AND period_end BETWEEN v_month AND v_end;
  -- Real si hay planillas emitidas del mes, salvo que el usuario pida estimar
  v_mode := coalesce(v_inputs->>'mode', CASE WHEN v_emitted > 0 THEN 'real' ELSE 'estimado' END);
  IF v_mode NOT IN ('real', 'estimado') THEN v_mode := 'estimado'; END IF;

  -- ── Empleados ──
  IF v_mode = 'real' THEN
    WITH lines AS (
      SELECT l.employee_id, l.employee_name AS name, l.afp_name, l.monthly_salary,
             l.base_salary AS fixed, l.overtime_pay + l.holiday_pay + l.vacation_pay + l.bonuses AS variable,
             l.aguinaldo, l.gross, l.isss_employee, l.isss_employer, l.insaforp, l.afp_employee, l.afp_employer, l.isr, 'planilla' AS source
      FROM payroll.payroll_lines l JOIN payroll.payrolls p ON p.id = l.payroll_id
      WHERE p.tenant_id = p_tenant AND p.status = 'emitida' AND p.period_end BETWEEN v_month AND v_end
      UNION ALL
      SELECT t.employee_id, t.employee_name, e.afp_name, t.monthly_salary,
             t.pending_salary, t.vacation + t.indemnity + t.other_income, t.aguinaldo, t.gross,
             t.isss_employee, t.isss_employer, 0, t.afp_employee, t.afp_employer, t.isr, 'liquidación'
      FROM payroll.terminations t JOIN payroll.employees e ON e.id = t.employee_id
      WHERE t.tenant_id = p_tenant AND t.status = 'registrada' AND t.termination_date BETWEEN v_month AND v_end
    )
    SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.name), '[]') INTO v_emps FROM (
      SELECT employee_id, max(name) AS name, max(afp_name) AS afp_name, max(monthly_salary) AS monthly_salary,
             sum(fixed) AS fixed, sum(variable) AS variable, sum(aguinaldo) AS aguinaldo, sum(gross) AS gross,
             sum(isss_employee) AS isss_employee, sum(isss_employer) AS isss_employer, sum(insaforp) AS insaforp,
             sum(afp_employee) AS afp_employee, sum(afp_employer) AS afp_employer, sum(isr) AS isr,
             string_agg(DISTINCT source, ', ') AS source
      FROM lines GROUP BY employee_id
    ) x;
  ELSE
    SELECT coalesce(jsonb_agg(to_jsonb(x) - 'applies_isss' - 'applies_afp' - 'applies_isr' - 'isss_base' - 'afp_base' - 'days' ORDER BY x.name), '[]') INTO v_emps FROM (
      SELECT c.*,
             CASE WHEN c.applies_isr THEN payroll.isr_retention(p_tenant, 'mensual',
               greatest(c.gross - c.isss_employee - c.afp_employee, 0)) ELSE 0 END AS isr
      FROM (
        SELECT b.*,
               round(b.isss_base * s.isss_employee_rate, 2) AS isss_employee,
               round(b.isss_base * s.isss_employer_rate, 2) AS isss_employer,
               CASE WHEN s.insaforp_applies AND b.applies_isss THEN round(b.gross * s.insaforp_rate, 2) ELSE 0 END AS insaforp,
               round(b.afp_base * s.afp_employee_rate, 2) AS afp_employee,
               round(b.afp_base * s.afp_employer_rate, 2) AS afp_employer
        FROM (
          SELECT a.*, a.fixed + a.variable AS gross,
                 CASE WHEN a.applies_isss THEN least(a.fixed + a.variable, s.isss_cap) ELSE 0 END AS isss_base,
                 CASE WHEN a.applies_afp THEN CASE WHEN s.afp_cap IS NULL THEN a.fixed + a.variable
                                                   ELSE least(a.fixed + a.variable, s.afp_cap) END ELSE 0 END AS afp_base
          FROM (
            SELECT e.id AS employee_id, e.full_name AS name, e.afp_name, e.monthly_salary,
                   e.applies_isss, e.applies_afp, e.applies_isr, d.days,
                   CASE WHEN d.days >= 30 THEN e.monthly_salary ELSE round(e.monthly_salary / 30 * d.days, 2) END AS fixed,
                   round(greatest(coalesce(accounting.num(v_inputs->'variable'->(e.id::TEXT)->>'amount'), 0), 0), 2) AS variable,
                   v_inputs->'variable'->(e.id::TEXT)->>'note' AS variable_note,
                   0::NUMERIC AS aguinaldo, 'estimado' AS source
            FROM payroll.employees e
            CROSS JOIN LATERAL (SELECT payroll.commercial_days(greatest(e.hire_date, v_month), least(coalesce(e.termination_date, v_end), v_end)) AS days) d
            WHERE e.tenant_id = p_tenant AND e.hire_date <= v_end AND (e.termination_date IS NULL OR e.termination_date >= v_month)
          ) a
        ) b
      ) c
    ) x;
  END IF;

  SELECT coalesce(sum((e->>'gross')::NUMERIC), 0) AS gross, coalesce(sum((e->>'fixed')::NUMERIC), 0) AS fixed,
         coalesce(sum((e->>'variable')::NUMERIC + (e->>'aguinaldo')::NUMERIC), 0) AS variable,
         coalesce(sum((e->>'isss_employee')::NUMERIC), 0) AS isss_employee, coalesce(sum((e->>'isss_employer')::NUMERIC), 0) AS isss_employer,
         coalesce(sum((e->>'insaforp')::NUMERIC), 0) AS insaforp,
         coalesce(sum((e->>'afp_employee')::NUMERIC), 0) AS afp_employee, coalesce(sum((e->>'afp_employer')::NUMERIC), 0) AS afp_employer,
         coalesce(sum((e->>'isr')::NUMERIC), 0) AS isr, count(*) AS n
  INTO tot FROM jsonb_array_elements(v_emps) e;

  -- ── Honorarios: libro de compras + estimados del usuario ──
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'supplier', c.proveedor_nombre, 'document_type', coalesce(c.metadata->>'tipoDocumento', ''),
           'document_number', coalesce(c.metadata->>'numeroControl', c.metadata->>'codigoGeneracion', ''),
           'issue_date', c.fecha, 'amount', coalesce(c.gravado, 0) + coalesce(c.exento, 0),
           'withheld', accounting.num(c.metadata->>'retencionRenta')) ORDER BY c.fecha, c.proveedor_nombre), '[]')
  INTO v_fees
  FROM public.compras c
  WHERE c.tenant_id = p_tenant AND c.fecha BETWEEN v_month AND v_end
    AND NOT coalesce((c.metadata->>'anulado')::BOOLEAN, false)
    AND accounting.num(c.metadata->>'retencionRenta') > 0;

  SELECT coalesce(jsonb_agg(f || jsonb_build_object(
           'kind', CASE WHEN f->>'kind' = 'no_domiciliado' THEN 'no_domiciliado' ELSE 'domiciliado' END,
           'rate', CASE WHEN f->>'kind' = 'no_domiciliado' THEN s.fee_nonresident_rate ELSE s.fee_withholding_rate END,
           'amount', round(greatest(coalesce(accounting.num(f->>'amount'), 0), 0), 2),
           'withheld', round(round(greatest(coalesce(accounting.num(f->>'amount'), 0), 0), 2)
                       * CASE WHEN f->>'kind' = 'no_domiciliado' THEN s.fee_nonresident_rate ELSE s.fee_withholding_rate END, 2))), '[]')
  INTO v_manual
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_inputs->'fees') = 'array' THEN v_inputs->'fees' ELSE '[]' END) f
  WHERE jsonb_typeof(f) = 'object' AND coalesce(accounting.num(f->>'amount'), 0) > 0;

  v_isr_fees := coalesce((SELECT sum((x->>'withheld')::NUMERIC) FROM jsonb_array_elements(v_fees) x), 0)
              + coalesce((SELECT sum((x->>'withheld')::NUMERIC) FROM jsonb_array_elements(v_manual) x), 0);

  -- ── Hacienda: IVA (F-07) de la posición fiscal; anticipo sobre las ventas netas del mes ──
  v_raw := accounting.fiscal_month_raw(p_tenant, v_month);
  SELECT m INTO v_fiscal FROM accounting.fiscal_months(p_tenant, v_month) m WHERE (m->>'period')::DATE = v_month;
  v_rate := coalesce((SELECT pago_a_cuenta_rate FROM accounting.fiscal_settings WHERE tenant_id = p_tenant), 0.0175);
  v_anticipo := coalesce((v_fiscal->>'pago_a_cuenta')::NUMERIC, (v_raw->>'pago_a_cuenta')::NUMERIC, 0);
  v_f07 := (v_fiscal->>'f07')::NUMERIC;
  SELECT coalesce(sum(amount) FILTER (WHERE form = 'F07'), 0), coalesce(sum(amount) FILTER (WHERE form = 'F14'), 0)
  INTO v_paid07, v_paid14
  FROM accounting.fiscal_payments WHERE tenant_id = p_tenant AND period = v_month AND status = 'vigente';

  v_payees := jsonb_build_array(
    jsonb_build_object('key', 'f07', 'payee', 'Hacienda', 'concept', 'IVA (F-07)', 'amount', v_f07, 'paid', v_paid07, 'due', v_due,
      'detail', CASE WHEN v_f07 IS NULL THEN 'Configura el punto de partida en IVA y pago a cuenta' ELSE 'Débito − crédito − remanente + retenciones de IVA' END,
      'parts', CASE WHEN v_f07 IS NULL THEN NULL
                    ELSE jsonb_build_object('iva', (v_fiscal->>'iva_a_pagar')::NUMERIC, 'ret_iva', (v_fiscal->>'ret_iva_hechas')::NUMERIC) END),
    jsonb_build_object('key', 'f14', 'payee', 'Hacienda', 'concept', 'Anticipo y retenciones de renta (F-14)',
      'amount', round(v_anticipo + tot.isr + v_isr_fees, 2), 'paid', v_paid14, 'due', v_due,
      'parts', jsonb_build_object('anticipo', v_anticipo, 'isr_employees', tot.isr, 'isr_fees', v_isr_fees)),
    jsonb_build_object('key', 'isss', 'payee', 'ISSS', 'concept', CASE WHEN tot.insaforp > 0 THEN 'Planilla ISSS + INSAFORP' ELSE 'Planilla ISSS' END,
      'amount', tot.isss_employee + tot.isss_employer + tot.insaforp, 'due', v_due,
      'paid', (SELECT coalesce(sum(amount), 0) FROM accounting.obligation_payments
                WHERE tenant_id = p_tenant AND period = v_month AND payee_key = 'isss' AND status = 'vigente'),
      'parts', jsonb_build_object('laboral', tot.isss_employee, 'patronal', tot.isss_employer, 'insaforp', tot.insaforp))
  ) || coalesce((
    SELECT jsonb_agg(jsonb_build_object('key', 'afp_' || coalesce(a.afp, 'sin'), 'payee',
             CASE a.afp WHEN 'confia' THEN 'AFP Confía' WHEN 'crecer' THEN 'AFP Crecer' ELSE 'AFP (sin asignar)' END,
             'concept', 'Planilla previsional', 'amount', a.laboral + a.patronal, 'due', v_due,
             'paid', (SELECT coalesce(sum(amount), 0) FROM accounting.obligation_payments
                       WHERE tenant_id = p_tenant AND period = v_month AND payee_key = 'afp_' || coalesce(a.afp, 'sin') AND status = 'vigente'),
             'parts', jsonb_build_object('laboral', a.laboral, 'patronal', a.patronal)) ORDER BY a.afp)
    FROM (SELECT e->>'afp_name' AS afp, sum((e->>'afp_employee')::NUMERIC) AS laboral, sum((e->>'afp_employer')::NUMERIC) AS patronal
          FROM jsonb_array_elements(v_emps) e GROUP BY 1
          HAVING sum((e->>'afp_employee')::NUMERIC) + sum((e->>'afp_employer')::NUMERIC) > 0) a), '[]');

  RETURN jsonb_build_object(
    'period', v_month,
    'mode', v_mode,
    'emitted_payrolls', v_emitted,
    'can_see_employees', p_with_employees,
    'settings', jsonb_build_object('isss_employee_rate', s.isss_employee_rate, 'isss_employer_rate', s.isss_employer_rate, 'isss_cap', s.isss_cap,
                  'afp_employee_rate', s.afp_employee_rate, 'afp_employer_rate', s.afp_employer_rate, 'afp_cap', s.afp_cap,
                  'insaforp_applies', s.insaforp_applies, 'insaforp_rate', s.insaforp_rate,
                  'fee_withholding_rate', s.fee_withholding_rate, 'fee_nonresident_rate', s.fee_nonresident_rate,
                  'pago_a_cuenta_rate', v_rate),
    'inputs', v_inputs,
    'saved', v_saved.tenant_id IS NOT NULL,
    'saved_at', v_saved.updated_at, 'saved_by', v_saved.updated_by,
    'employees', CASE WHEN p_with_employees THEN v_emps ELSE '[]' END,
    'employee_totals', jsonb_build_object('count', tot.n, 'gross', tot.gross, 'fixed', tot.fixed, 'variable', tot.variable,
                         'isss_employee', tot.isss_employee, 'isss_employer', tot.isss_employer, 'insaforp', tot.insaforp,
                         'afp_employee', tot.afp_employee, 'afp_employer', tot.afp_employer, 'isr', tot.isr),
    'fees', jsonb_build_object('purchases', v_fees, 'manual', v_manual, 'withheld', v_isr_fees),
    'sales_net', (v_raw->>'ventas_netas')::NUMERIC,
    'fiscal_configured', v_fiscal IS NOT NULL,
    'payees', v_payees,
    'total', (SELECT coalesce(sum((p->>'amount')::NUMERIC), 0) FROM jsonb_array_elements(v_payees) p),
    'total_pending', (SELECT coalesce(sum(greatest((p->>'amount')::NUMERIC - coalesce((p->>'paid')::NUMERIC, 0), 0)), 0) FROM jsonb_array_elements(v_payees) p),
    'payments', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', op.id, 'payee_key', op.payee_key, 'payment_date', op.payment_date,
                   'amount', op.amount, 'reference', op.reference, 'status', op.status, 'entry_id', op.entry_id, 'created_by_name', op.created_by_name)
                   ORDER BY op.payment_date, op.id), '[]')
                 FROM accounting.obligation_payments op WHERE op.tenant_id = p_tenant AND op.period = v_month),
    'due', v_due);
END;
$$;

/**
 * Pago al ISSS o a una AFP: Debe ISSS / AFP por pagar (laboral + patronal,
 * acreditados al emitir la planilla) / Haber banco o caja (conciliable).
 */
CREATE OR REPLACE FUNCTION accounting.register_obligation_payment(
  p_tenant BIGINT, p_key TEXT, p_period DATE, p_date DATE, p_amount NUMERIC, p_fund BIGINT, p_reference TEXT
)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  v_p     DATE := date_trunc('month', p_period)::DATE;
  v_label TEXT;
  v_id    BIGINT;
  v_entry BIGINT;
BEGIN
  IF p_key NOT IN ('isss', 'afp_confia', 'afp_crecer', 'afp_sin') THEN RAISE EXCEPTION 'Pagador inválido' USING ERRCODE = '22023'; END IF;
  IF coalesce(p_amount, 0) <= 0 THEN RAISE EXCEPTION 'Indica el monto pagado' USING ERRCODE = '22023'; END IF;
  v_label := CASE p_key WHEN 'isss' THEN 'ISSS' WHEN 'afp_confia' THEN 'AFP Confía' WHEN 'afp_crecer' THEN 'AFP Crecer' ELSE 'AFP' END;
  INSERT INTO accounting.obligation_payments (tenant_id, payee_key, period, payment_date, amount, fund_account_id, reference, created_by_name)
  VALUES (p_tenant, p_key, v_p, p_date, round(p_amount, 2), p_fund, NULLIF(btrim(p_reference), ''), accounting.ctx_user_name())
  RETURNING id INTO v_id;
  v_entry := accounting.create_entry(p_tenant, p_date, 'SOCIAL_SECURITY_PAYMENT', 'obligaciones', 'OP' || v_id,
    v_label || ' ' || to_char(v_p, 'MM/YYYY'), 'Pago de planilla ' || v_label || ' de ' || to_char(v_p, 'MM/YYYY'),
    accounting.amount_lines(jsonb_build_array(
      jsonb_build_object('account_id', accounting.role_account(p_tenant, CASE WHEN p_key = 'isss' THEN 'payroll_isss_payable' ELSE 'payroll_afp_payable' END),
                         'amount', round(p_amount, 2), 'description', v_label || ' laboral y patronal'),
      jsonb_build_object('account_id', p_fund, 'amount', -round(p_amount, 2), 'description', 'Pago ' || v_label || ' ' || to_char(v_p, 'MM/YYYY')))));
  UPDATE accounting.obligation_payments SET entry_id = v_entry WHERE id = v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION accounting.void_obligation_payment(p_tenant BIGINT, p_id BIGINT, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  v accounting.obligation_payments%ROWTYPE;
BEGIN
  SELECT * INTO v FROM accounting.obligation_payments WHERE id = p_id AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND OR v.status <> 'vigente' THEN RAISE EXCEPTION 'Pago no encontrado' USING ERRCODE = 'P0002'; END IF;
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'Indica el motivo' USING ERRCODE = '22023'; END IF;
  IF v.entry_id IS NOT NULL THEN PERFORM accounting.reverse_entry(p_tenant, v.entry_id, p_reason, 'SOCIAL_SECURITY_PAYMENT_VOIDED'); END IF;
  UPDATE accounting.obligation_payments SET status = 'anulado', void_reason = btrim(p_reason) WHERE id = p_id;
END;
$$;
