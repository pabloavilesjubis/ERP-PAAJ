-- =============================================================================
-- 011_fiscal_position — Posición fiscal mensual (F6). Portado de ChuchoWash
-- (0053) y conectado a la contabilidad (allá los pagos eran solo registro).
--
--  * IVA (F-07): débito (ventas FCF/CCF − NC) − crédito (compras − NC de
--    proveedores) − percepción 1% − retenciones de IVA que nos hicieron −
--    remanente del mes anterior; + retenciones de IVA que hicimos (se pagan).
--    El remanente se encadena desde el mes inicial configurado.
--  * Pago a cuenta y retenciones (F-14): tasa (1.75%) × ventas netas (sin las
--    que tuvieron retención de renta, igual que el resumen del ERP) + renta
--    retenida en planilla, liquidaciones y compras.
--  * Liquidación del IVA del mes: asiento que salda débito, crédito,
--    percepciones y retenciones contra "IVA por pagar" (o deja remanente).
--  * Pago de F-07 / F-14: asiento contra el banco (conciliable).
-- Las cifras salen de los documentos (ventas, compras, planillas), igual que
-- las declaraciones; los asientos llevan esas cifras a la contabilidad.
-- =============================================================================

CREATE TABLE accounting.fiscal_settings (
  tenant_id          BIGINT PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  opening_period     DATE NOT NULL,                       -- primer día del mes desde el que se calcula
  opening_remanente  NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (opening_remanente >= 0),
  pago_a_cuenta_rate NUMERIC(6,4) NOT NULL DEFAULT 0.0175 CHECK (pago_a_cuenta_rate BETWEEN 0 AND 1),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by         TEXT
);

CREATE TABLE accounting.fiscal_liquidations (
  tenant_id  BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  period     DATE NOT NULL,                               -- primer día del mes
  entry_id   BIGINT NOT NULL REFERENCES accounting.journal_entries(id),
  amounts    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, period)
);

CREATE TABLE accounting.fiscal_payments (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  form            TEXT NOT NULL CHECK (form IN ('F07', 'F14')),
  period          DATE NOT NULL,
  payment_date    DATE NOT NULL,
  amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  breakdown       JSONB NOT NULL,                         -- {main, withholdings}
  fund_account_id BIGINT NOT NULL REFERENCES accounting.accounts(id),
  reference       TEXT,
  status          TEXT NOT NULL DEFAULT 'vigente' CHECK (status IN ('vigente', 'anulado')),
  entry_id        BIGINT REFERENCES accounting.journal_entries(id),
  created_by_name TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  void_reason     TEXT
);
CREATE INDEX idx_fiscal_payments ON accounting.fiscal_payments(tenant_id, period);

/** Cifras de un mes sin el remanente encadenado. */
CREATE OR REPLACE FUNCTION accounting.fiscal_month_raw(p_tenant BIGINT, p_period DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_from DATE := date_trunc('month', p_period)::DATE;
  v_to   DATE := (date_trunc('month', p_period) + INTERVAL '1 month - 1 day')::DATE;
  s      accounting.fiscal_settings;
  v      RECORD;
  c      RECORD;
  v_isr_payroll NUMERIC := 0;
BEGIN
  SELECT * INTO s FROM accounting.fiscal_settings WHERE tenant_id = p_tenant;

  -- Ventas: FCF con IVA incluido; CCF/NC separados; anuladas fuera
  SELECT
    coalesce(sum(sg * debito), 0) AS debito,
    coalesce(sum(sg * neto), 0) AS ventas_netas,
    coalesce(sum(sg * neto) FILTER (WHERE rrenta = 0), 0) AS base_pago_cuenta,
    coalesce(sum(sg * riva), 0) AS ret_iva_clientes,
    coalesce(sum(sg * rrenta), 0) AS ret_renta_clientes,
    count(*) AS docs
  INTO v
  FROM (
    SELECT CASE WHEN coalesce(vt.metadata->>'tipoDocumento', d.tipo_dte, '') = '05' THEN -1 ELSE 1 END AS sg,
           CASE WHEN vt.kind = 'consumidor' AND vt.gravado IS NULL
                THEN coalesce(vt.monto, 0) - round(coalesce(vt.monto, 0) / 1.13, 2)
                ELSE coalesce(vt.iva, round(coalesce(vt.gravado, 0) * 0.13, 2)) END AS debito,
           CASE WHEN vt.kind = 'consumidor' AND vt.gravado IS NULL
                THEN round(coalesce(vt.monto, 0) / 1.13, 2)
                ELSE coalesce(vt.gravado, 0) + coalesce(vt.exento, 0) END AS neto,
           coalesce(accounting.num(d.dte_json->'resumen'->>'ivaRete1'), 0) + accounting.num(vt.metadata->>'ivaRetenido') AS riva,
           accounting.num(vt.metadata->>'retencionRenta') AS rrenta
    FROM public.ventas vt LEFT JOIN public.dtes d ON d.id = vt.dte_id
    WHERE vt.tenant_id = p_tenant AND vt.fecha BETWEEN v_from AND v_to
      AND NOT coalesce((vt.metadata->>'anulado')::BOOLEAN, false)
  ) x;

  -- Compras
  SELECT
    coalesce(sum(sg * coalesce(iva, 0)), 0) AS credito,
    coalesce(sum(sg * accounting.num(metadata->>'ivaPercibido')), 0) AS percepcion,
    coalesce(sum(sg * accounting.num(metadata->>'ivaRetenido')), 0) AS ret_iva_hechas,
    coalesce(sum(sg * accounting.num(metadata->>'retencionRenta')), 0) AS isr_compras,
    count(*) AS docs
  INTO c
  FROM (SELECT *, CASE WHEN metadata->>'tipoDocumento' = '05' THEN -1 ELSE 1 END AS sg FROM public.compras
         WHERE tenant_id = p_tenant AND fecha BETWEEN v_from AND v_to AND NOT coalesce((metadata->>'anulado')::BOOLEAN, false)) y;

  -- Renta retenida en planillas y liquidaciones (si el módulo existe)
  IF to_regclass('payroll.payrolls') IS NOT NULL THEN
    EXECUTE $q$
      SELECT coalesce((SELECT sum(isr) FROM payroll.payrolls WHERE tenant_id = $1 AND status = 'emitida' AND payment_date BETWEEN $2 AND $3), 0)
           + coalesce((SELECT sum(isr) FROM payroll.terminations WHERE tenant_id = $1 AND status = 'registrada' AND termination_date BETWEEN $2 AND $3), 0)
    $q$ INTO v_isr_payroll USING p_tenant, v_from, v_to;
  END IF;

  RETURN jsonb_build_object(
    'period', v_from,
    'ventas_docs', v.docs, 'compras_docs', c.docs,
    'debito', round(v.debito, 2), 'ventas_netas', round(v.ventas_netas, 2), 'base_pago_cuenta', round(v.base_pago_cuenta, 2),
    'ret_iva_clientes', round(v.ret_iva_clientes, 2), 'ret_renta_clientes', round(v.ret_renta_clientes, 2),
    'credito', round(c.credito, 2), 'percepcion', round(c.percepcion, 2), 'ret_iva_hechas', round(c.ret_iva_hechas, 2),
    'isr_compras', round(c.isr_compras, 2), 'isr_planilla', round(v_isr_payroll, 2),
    'pago_a_cuenta', round(v.base_pago_cuenta * coalesce(s.pago_a_cuenta_rate, 0.0175), 2));
END;
$$;

/**
 * Meses desde el inicio configurado hasta p_to, con el remanente encadenado.
 * iva_neto = débito − crédito − percepción − retenciones de clientes − remanente anterior
 * f07 = max(iva_neto, 0) + retenciones de IVA hechas;  f14 = pago a cuenta + renta retenida
 */
CREATE OR REPLACE FUNCTION accounting.fiscal_months(p_tenant BIGINT, p_to DATE)
RETURNS SETOF JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
  s       accounting.fiscal_settings;
  v_p     DATE;
  v_rem   NUMERIC(14,2);
  m       JSONB;
  v_net   NUMERIC(14,2);
  v_f07   NUMERIC(14,2);
  v_f14   NUMERIC(14,2);
  v_paid07 NUMERIC(14,2);
  v_paid14 NUMERIC(14,2);
  v_liq   BIGINT;
BEGIN
  SELECT * INTO s FROM accounting.fiscal_settings WHERE tenant_id = p_tenant;
  IF NOT FOUND THEN RETURN; END IF;
  v_p := date_trunc('month', s.opening_period)::DATE;
  v_rem := s.opening_remanente;
  WHILE v_p <= date_trunc('month', p_to)::DATE LOOP
    m := accounting.fiscal_month_raw(p_tenant, v_p);
    v_net := (m->>'debito')::NUMERIC - (m->>'credito')::NUMERIC - (m->>'percepcion')::NUMERIC - (m->>'ret_iva_clientes')::NUMERIC - v_rem;
    v_f07 := greatest(v_net, 0) + (m->>'ret_iva_hechas')::NUMERIC;
    v_f14 := (m->>'pago_a_cuenta')::NUMERIC + (m->>'isr_planilla')::NUMERIC + (m->>'isr_compras')::NUMERIC;
    SELECT coalesce(sum(amount) FILTER (WHERE form = 'F07'), 0), coalesce(sum(amount) FILTER (WHERE form = 'F14'), 0)
      INTO v_paid07, v_paid14
      FROM accounting.fiscal_payments WHERE tenant_id = p_tenant AND period = v_p AND status = 'vigente';
    SELECT entry_id INTO v_liq FROM accounting.fiscal_liquidations WHERE tenant_id = p_tenant AND period = v_p;
    RETURN NEXT m || jsonb_build_object(
      'remanente_anterior', v_rem, 'iva_neto', v_net, 'iva_a_pagar', greatest(v_net, 0), 'remanente_siguiente', greatest(-v_net, 0),
      'f07', v_f07, 'f14', v_f14, 'pagado_f07', v_paid07, 'pagado_f14', v_paid14,
      'pendiente', greatest(v_f07 - v_paid07, 0) + greatest(v_f14 - v_paid14, 0),
      'liquidation_entry_id', v_liq);
    v_rem := greatest(-v_net, 0);
    v_p := (v_p + INTERVAL '1 month')::DATE;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION accounting.fiscal_pending(p_tenant BIGINT)
RETURNS NUMERIC LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum((m->>'pendiente')::NUMERIC), 0)
  FROM accounting.fiscal_months(p_tenant, (date_trunc('month', now()) - INTERVAL '1 month')::DATE) m;
$$;

/** Asiento de liquidación del IVA de un mes (ver encabezado). */
CREATE OR REPLACE FUNCTION accounting.liquidate_vat(p_tenant BIGINT, p_period DATE)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  v_p    DATE := date_trunc('month', p_period)::DATE;
  m      JSONB;
  v_x    NUMERIC(14,2);
  v_entry BIGINT;
BEGIN
  SELECT x INTO m FROM accounting.fiscal_months(p_tenant, v_p) x WHERE (x->>'period')::DATE = v_p;
  IF m IS NULL THEN RAISE EXCEPTION 'El mes es anterior al inicio de la posición fiscal o falta configurarla' USING ERRCODE = '22023'; END IF;
  IF m->>'liquidation_entry_id' IS NOT NULL THEN RAISE EXCEPTION 'El IVA de ese mes ya está liquidado' USING ERRCODE = '22023'; END IF;
  v_x := (m->>'iva_neto')::NUMERIC;
  v_entry := accounting.create_entry(p_tenant, (v_p + INTERVAL '1 month - 1 day')::DATE, 'VAT_LIQUIDATION', 'fiscal', v_p::TEXT,
    'IVA ' || to_char(v_p, 'MM/YYYY'), 'Liquidación del IVA de ' || to_char(v_p, 'MM/YYYY'),
    accounting.amount_lines(jsonb_build_array(
      jsonb_build_object('account_id', CASE WHEN (m->>'debito')::NUMERIC <> 0 THEN accounting.role_account(p_tenant, 'vat_debit') END,
                         'amount', (m->>'debito')::NUMERIC, 'description', 'Débito fiscal del mes'),
      jsonb_build_object('account_id', CASE WHEN (m->>'percepcion')::NUMERIC <> 0 THEN accounting.role_account(p_tenant, 'vat_perceived') END,
                         'amount', -(m->>'percepcion')::NUMERIC, 'description', 'Percepciones'),
      jsonb_build_object('account_id', CASE WHEN (m->>'ret_iva_clientes')::NUMERIC <> 0 THEN accounting.role_account(p_tenant, 'vat_withheld_by_customers') END,
                         'amount', -(m->>'ret_iva_clientes')::NUMERIC, 'description', 'Retenciones de IVA de clientes'),
      jsonb_build_object('account_id', accounting.role_account(p_tenant, 'vat_credit'),
                         'amount', -((m->>'credito')::NUMERIC + (m->>'remanente_anterior')::NUMERIC + least(v_x, 0)),
                         'description', 'Crédito fiscal aplicado'),
      jsonb_build_object('account_id', CASE WHEN v_x > 0 THEN accounting.role_account(p_tenant, 'vat_payable') END,
                         'amount', -greatest(v_x, 0), 'description', 'IVA a pagar'))));
  IF v_entry IS NULL THEN RAISE EXCEPTION 'No hay IVA que liquidar en ese mes' USING ERRCODE = '22023'; END IF;
  INSERT INTO accounting.fiscal_liquidations (tenant_id, period, entry_id, amounts) VALUES (p_tenant, v_p, v_entry, m);
  RETURN v_entry;
END;
$$;

CREATE OR REPLACE FUNCTION accounting.undo_vat_liquidation(p_tenant BIGINT, p_period DATE, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  v accounting.fiscal_liquidations%ROWTYPE;
BEGIN
  SELECT * INTO v FROM accounting.fiscal_liquidations WHERE tenant_id = p_tenant AND period = date_trunc('month', p_period)::DATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ese mes no está liquidado' USING ERRCODE = '22023'; END IF;
  PERFORM accounting.reverse_entry(p_tenant, v.entry_id, coalesce(NULLIF(btrim(p_reason), ''), 'Liquidación deshecha'), 'VAT_LIQUIDATION_REVERSED');
  DELETE FROM accounting.fiscal_liquidations WHERE tenant_id = p_tenant AND period = v.period;
END;
$$;

/**
 * Pago de F-07 (Debe IVA por pagar + IVA retenido por pagar) o F-14 (Debe
 * pago a cuenta + renta retenida por pagar) / Haber banco o caja.
 * p_main: IVA a pagar o pago a cuenta; p_withholdings: retenciones del formulario.
 */
CREATE OR REPLACE FUNCTION accounting.register_fiscal_payment(
  p_tenant BIGINT, p_form TEXT, p_period DATE, p_date DATE, p_main NUMERIC, p_withholdings NUMERIC, p_fund BIGINT, p_reference TEXT
)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  v_p     DATE := date_trunc('month', p_period)::DATE;
  v_total NUMERIC(14,2) := round(coalesce(p_main, 0) + coalesce(p_withholdings, 0), 2);
  v_id    BIGINT;
  v_entry BIGINT;
BEGIN
  IF p_form NOT IN ('F07', 'F14') THEN RAISE EXCEPTION 'Formulario inválido' USING ERRCODE = '22023'; END IF;
  IF v_total <= 0 OR p_main < 0 OR p_withholdings < 0 THEN RAISE EXCEPTION 'Indica el monto pagado' USING ERRCODE = '22023'; END IF;
  INSERT INTO accounting.fiscal_payments (tenant_id, form, period, payment_date, amount, breakdown, fund_account_id, reference, created_by_name)
  VALUES (p_tenant, p_form, v_p, p_date, v_total, jsonb_build_object('main', round(p_main, 2), 'withholdings', round(p_withholdings, 2)),
          p_fund, NULLIF(btrim(p_reference), ''), accounting.ctx_user_name())
  RETURNING id INTO v_id;
  v_entry := accounting.create_entry(p_tenant, p_date, 'TAX_PAYMENT', 'fiscal', 'P' || v_id,
    p_form || ' ' || to_char(v_p, 'MM/YYYY'),
    CASE p_form WHEN 'F07' THEN 'Pago de IVA (F-07) de ' ELSE 'Pago a cuenta y retenciones (F-14) de ' END || to_char(v_p, 'MM/YYYY'),
    accounting.amount_lines(jsonb_build_array(
      jsonb_build_object('account_id', CASE WHEN p_main > 0 THEN accounting.role_account(p_tenant, CASE p_form WHEN 'F07' THEN 'vat_payable' ELSE 'payment_on_account' END) END,
                         'amount', round(p_main, 2), 'description', CASE p_form WHEN 'F07' THEN 'IVA del mes' ELSE 'Pago a cuenta' END),
      jsonb_build_object('account_id', CASE WHEN p_withholdings > 0 THEN accounting.role_account(p_tenant, CASE p_form WHEN 'F07' THEN 'vat_withheld' ELSE 'income_tax_withheld' END) END,
                         'amount', round(p_withholdings, 2), 'description', 'Retenciones'),
      jsonb_build_object('account_id', p_fund, 'amount', -v_total, 'description', p_form || ' ' || to_char(v_p, 'MM/YYYY')))));
  UPDATE accounting.fiscal_payments SET entry_id = v_entry WHERE id = v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION accounting.void_fiscal_payment(p_tenant BIGINT, p_id BIGINT, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  v accounting.fiscal_payments%ROWTYPE;
BEGIN
  SELECT * INTO v FROM accounting.fiscal_payments WHERE id = p_id AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND OR v.status <> 'vigente' THEN RAISE EXCEPTION 'Pago no encontrado' USING ERRCODE = 'P0002'; END IF;
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'Indica el motivo' USING ERRCODE = '22023'; END IF;
  IF v.entry_id IS NOT NULL THEN PERFORM accounting.reverse_entry(p_tenant, v.entry_id, p_reason, 'TAX_PAYMENT_VOIDED'); END IF;
  UPDATE accounting.fiscal_payments SET status = 'anulado', void_reason = btrim(p_reason) WHERE id = p_id;
END;
$$;
