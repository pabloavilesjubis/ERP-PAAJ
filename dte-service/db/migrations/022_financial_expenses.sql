-- =============================================================================
-- 022_financial_expenses — Gastos financieros (intereses) en compras.
--
-- Los intereses que cobran bancos y financieras no llevan IVA (o no da crédito),
-- pero son gasto del ejercicio para el impuesto sobre la renta. Ahora:
--  * Un DTE de un banco/financiera (actividad 64–66 o nombre de banco) con
--    líneas de intereses se registra como compra marcada
--    metadata.categoria = 'gasto_financiero' con metadata.intereses (la parte de
--    intereses: el capital y las pólizas no cuentan como intereses).
--  * Estados de cuenta en PDF (tarjetas de crédito, préstamos sin DTE): el
--    servidor lee el PDF y registra los intereses cobrados en el mes como
--    compra tipo 'EC' (no va al anexo de compras del F-07).
--  * Contabilización: los intereses van a «Gastos financieros» (nuevo rol
--    opcional; si no se asigna, «Gastos bancarios»; si tampoco, gasto normal).
--  * Se reclasifican las compras de bancos ya registradas desde el buzón.
-- =============================================================================

INSERT INTO accounting.role_definitions (role_key, label, group_name, description, sort_order) VALUES
  ('financial_expense', 'Gastos financieros (intereses)', 'Costos y gastos', 'Intereses de préstamos y tarjetas; si no se asigna se usa «Gastos bancarios»', 63)
ON CONFLICT (role_key) DO NOTHING;

ALTER TABLE accounting.mail_messages ADD COLUMN IF NOT EXISTS statement_checked BOOLEAN NOT NULL DEFAULT false;

/** Intereses de un DTE de banco/financiera: {intereses, detalle[]} o NULL si no aplica. */
CREATE OR REPLACE FUNCTION accounting.financial_breakdown(p_raw JSONB)
RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  WITH e AS (
    SELECT coalesce(p_raw->'emisor'->>'codActividad', '') AS act, upper(coalesce(p_raw->'emisor'->>'nombre', '')) AS nom
  ), l AS (
    SELECT btrim(coalesce(x->>'descripcion', '')) AS d,
           accounting.num(x->>'ventaGravada') + accounting.num(x->>'ventaExenta') + accounting.num(x->>'ventaNoSuj') + accounting.num(x->>'noGravado') AS m
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_raw->'cuerpoDocumento') = 'array' THEN p_raw->'cuerpoDocumento' ELSE '[]'::JSONB END) x
  ), i AS (
    SELECT coalesce(sum(m), 0) AS total, jsonb_agg(jsonb_build_object('descripcion', d, 'monto', m)) AS detalle
    FROM l WHERE d ~* 'inter[eé]s' AND m <> 0
  )
  SELECT CASE WHEN (e.act ~ '^6[456]' OR e.nom ~ '(BANCO|FINANCIER|COOPERATIVA|CAJA DE CR|AHORRO Y CR)') AND i.total > 0
              THEN jsonb_build_object('intereses', round(i.total, 2), 'detalle', i.detalle) END
  FROM e, i
$$;

/** Metadatos de compra para un gasto financiero. */
CREATE OR REPLACE FUNCTION accounting.financial_metadata(p_fin JSONB)
RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_fin IS NULL THEN NULL ELSE jsonb_build_object(
    'categoria', 'gasto_financiero',
    'intereses', to_char((p_fin->>'intereses')::NUMERIC, 'FM999999990.00'),
    'detalleIntereses', coalesce(p_fin->'detalle', '[]'::JSONB),
    'deducibleRenta', true) END
$$;

CREATE OR REPLACE FUNCTION accounting.ingest_received_dte(p_tenant BIGINT, p_doc JSONB, p_raw JSONB, p_source TEXT, p_meta JSONB)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_code    TEXT := upper(btrim(p_doc->>'generation_code'));
  v_stamp   TEXT := NULLIF(upper(btrim(p_doc->>'reception_stamp')), '');
  v_ctrl    TEXT := NULLIF(upper(btrim(p_doc->>'control_number')), '');
  v_type    TEXT := p_doc->>'document_type';
  v_status  TEXT := 'registrado';
  v_detail  TEXT;
  v_emisor  public.tenant_emisor%ROWTYPE;
  v_party   BIGINT;
  v_compra  BIGINT;
  v_id      BIGINT;
  v_nit     TEXT := accounting.digits(p_doc->>'issuer_nit');
  v_nrc     TEXT := accounting.digits(p_doc->>'issuer_nrc');
  v_rnit    TEXT := coalesce(accounting.digits(p_doc->>'receiver_nit'), '');
  v_rnrc    TEXT := coalesce(accounting.digits(p_doc->>'receiver_nrc'), '');
  v_rdui    TEXT := coalesce(accounting.digits(p_doc->>'receiver_dui'), '');
  v_credito BOOLEAN := (p_doc->>'document_type') IN ('03', '05', '06');
  v_fin     JSONB;
BEGIN
  IF coalesce(v_code, '') = '' THEN RAISE EXCEPTION 'El DTE no tiene código de generación' USING ERRCODE = '22023'; END IF;

  -- 1. Duplicados (buzón o libro de compras, por código o sello)
  IF EXISTS (SELECT 1 FROM accounting.received_dtes WHERE tenant_id = p_tenant AND status = 'registrado'
               AND (upper(generation_code) = v_code OR (v_stamp IS NOT NULL AND upper(reception_stamp) = v_stamp)))
     OR EXISTS (SELECT 1 FROM public.compras c WHERE c.tenant_id = p_tenant AND (
               upper(coalesce(c.metadata->>'numeroDocumento', '')) = v_code
            OR upper(coalesce(c.metadata->>'codigoGeneracion', '')) = v_code
            OR (v_stamp IS NOT NULL AND upper(coalesce(c.metadata->>'selloRecibido', '')) = v_stamp)
            OR (v_ctrl IS NOT NULL AND upper(coalesce(c.metadata->>'numeroControl', '')) = v_ctrl
                AND accounting.digits(coalesce(c.proveedor_nrc, '')) = v_nrc))) THEN
    v_status := 'duplicado';
    v_detail := 'Ya estaba registrado en el libro de compras';
  END IF;

  -- 2. ¿Es para esta empresa? Sin datos fiscales no se puede saber: no se registra.
  IF v_status = 'registrado' THEN
    SELECT * INTO v_emisor FROM public.tenant_emisor WHERE tenant_id = p_tenant;
    IF NOT FOUND THEN
      v_status := 'rechazado';
      v_detail := 'La empresa no tiene datos fiscales (Mi empresa): no se puede validar que el DTE sea para ella';
    ELSIF v_nit = accounting.digits(v_emisor.mh_nit) OR (v_nrc <> '' AND v_nrc = accounting.digits(v_emisor.emisor_nrc)) THEN
      v_status := 'rechazado';
      v_detail := 'Es un DTE emitido por esta misma empresa (una venta), no una compra';
    ELSIF v_rnit = '' AND v_rnrc = '' AND v_rdui = '' THEN
      v_status := 'rechazado';
      v_detail := 'El DTE no identifica al receptor (sin NIT, NRC ni DUI): no se puede saber si es para esta empresa';
    ELSIF NOT ((v_rnit <> '' AND v_rnit = accounting.digits(v_emisor.mh_nit))
            OR (v_rnrc <> '' AND v_rnrc = accounting.digits(v_emisor.emisor_nrc))
            OR (v_rdui <> '' AND v_rdui = coalesce(accounting.digits(v_emisor.emisor_dui), ''))
            OR (v_rdui <> '' AND v_rdui = accounting.digits(v_emisor.mh_nit))) THEN
      v_status := 'rechazado';
      v_detail := 'El receptor del DTE (' || coalesce(NULLIF(p_doc->>'receiver_name', ''), 'sin nombre') || ') no es esta empresa';
    END IF;
  END IF;
  IF v_status = 'registrado' AND v_type NOT IN ('01', '03', '05', '06', '11') THEN
    v_status := 'rechazado'; v_detail := 'El documento tipo ' || coalesce(v_type, '?') || ' no es una compra';
  END IF;
  IF v_status = 'registrado' AND v_stamp IS NULL THEN
    v_status := 'rechazado'; v_detail := 'El DTE no tiene sello de recepción del MH';
  END IF;

  IF v_status = 'registrado' THEN
    -- Banco o financiera que cobra intereses: gasto financiero (deducible en renta, sin IVA que acreditar)
    v_fin := CASE WHEN v_type IN ('01', '03', '11') THEN accounting.financial_breakdown(p_raw) END;
    -- 3. Proveedor: existente o nuevo con los datos del emisor
    v_party := accounting.match_party(p_tenant, v_nit, v_nrc, NULL, p_doc->>'issuer_name');
    IF v_party IS NULL THEN
      INSERT INTO public.contribuyentes (tenant_id, nombre, nit, nrc, giro, telefono, email, direccion, departamento, municipio, cod_actividad, tipo, metadata)
      VALUES (p_tenant, coalesce(NULLIF(btrim(p_doc->>'issuer_name'), ''), 'Proveedor ' || v_nrc), NULLIF(v_nit, ''), NULLIF(v_nrc, ''),
              p_doc->'issuer'->>'activityDesc', p_doc->'issuer'->>'phone', p_doc->'issuer'->>'email', p_doc->'issuer'->>'address',
              p_doc->'issuer'->>'departmentCode', p_doc->'issuer'->>'municipalityCode', p_doc->'issuer'->>'activityCode', 'Proveedor',
              '{"origen": "buzon_dte"}'::JSONB)
      RETURNING id INTO v_party;
    END IF;

    -- 4. Libro de compras (el trigger lo contabiliza)
    INSERT INTO public.compras (tenant_id, fecha, proveedor_nombre, proveedor_nit, proveedor_nrc, descripcion, gravado, exento, iva, total, metadata)
    VALUES (p_tenant, coalesce(NULLIF(p_doc->>'issue_date', '')::DATE, accounting.today()), coalesce(NULLIF(btrim(p_doc->>'issuer_name'), ''), 'Proveedor'),
            NULLIF(v_nit, ''), NULLIF(v_nrc, ''),
            CASE WHEN v_fin IS NOT NULL THEN 'Intereses · ' || coalesce(NULLIF(p_doc->>'description', ''), 'gasto financiero')
                 ELSE NULLIF(p_doc->>'description', '') END,
            -- Sin crédito fiscal el IVA es costo: la base es el total menos lo exento
            CASE WHEN v_credito THEN coalesce((p_doc->>'taxable_amount')::NUMERIC, 0)
                 ELSE coalesce((p_doc->>'total_amount')::NUMERIC, 0) - coalesce((p_doc->>'exempt_amount')::NUMERIC, 0)
                      - coalesce((p_doc->>'non_subject_amount')::NUMERIC, 0) END,
            coalesce((p_doc->>'exempt_amount')::NUMERIC, 0) + coalesce((p_doc->>'non_subject_amount')::NUMERIC, 0),
            CASE WHEN v_credito THEN coalesce((p_doc->>'iva_amount')::NUMERIC, 0) ELSE 0 END,
            coalesce((p_doc->>'total_amount')::NUMERIC, 0),
            jsonb_strip_nulls(jsonb_build_object(
              'claseDocumento', '4', 'tipoDocumento', v_type, 'numeroDocumento', v_code, 'codigoGeneracion', v_code,
              'numeroControl', v_ctrl, 'selloRecibido', v_stamp, 'nit', NULLIF(v_nit, ''), 'source', 'imported', 'origen', 'buzon',
              'tipoOperacion', '1', 'clasificacion', '2',
              'ivaNoDeducible', CASE WHEN NOT v_credito THEN to_char(coalesce((p_doc->>'iva_amount')::NUMERIC, 0), 'FM999999990.00') END,
              'ivaPercibido', CASE WHEN (p_doc->>'iva_perceived')::NUMERIC > 0 THEN to_char((p_doc->>'iva_perceived')::NUMERIC, 'FM999999990.00') END,
              'ivaRetenido', CASE WHEN (p_doc->>'iva_withheld')::NUMERIC > 0 THEN to_char((p_doc->>'iva_withheld')::NUMERIC, 'FM999999990.00') END,
              'retencionRenta', CASE WHEN (p_doc->>'income_tax_withheld')::NUMERIC > 0 THEN to_char((p_doc->>'income_tax_withheld')::NUMERIC, 'FM999999990.00') END,
              'otrosTributos', CASE WHEN (p_doc->>'other_taxes')::NUMERIC > 0 THEN to_char((p_doc->>'other_taxes')::NUMERIC, 'FM999999990.00') END))
            || coalesce(accounting.financial_metadata(v_fin), '{}'::JSONB))
    RETURNING id INTO v_compra;
    v_detail := CASE WHEN v_fin IS NOT NULL THEN 'Registrado como gasto financiero: intereses $' || to_char((v_fin->>'intereses')::NUMERIC, 'FM999,999,990.00')
                     WHEN v_credito THEN 'Registrado en el libro de compras'
                     ELSE 'Registrado como compra sin crédito fiscal (el IVA no se deduce)' END;
  END IF;

  INSERT INTO accounting.received_dtes (tenant_id, source, status, detail, generation_code, control_number, reception_stamp, document_type,
    issue_date, issuer_nit, issuer_nrc, issuer_name, receiver_nit, receiver_nrc, taxable_amount, exempt_amount, non_subject_amount,
    iva_amount, other_taxes, iva_perceived, iva_withheld, income_tax_withheld, total_amount, compra_id, raw, file_name, mail_from,
    mail_subject, created_by_name)
  VALUES (p_tenant, p_source, v_status, v_detail, v_code, v_ctrl, v_stamp, v_type, NULLIF(p_doc->>'issue_date', '')::DATE,
    NULLIF(v_nit, ''), NULLIF(v_nrc, ''), p_doc->>'issuer_name', NULLIF(accounting.digits(p_doc->>'receiver_nit'), ''),
    NULLIF(accounting.digits(p_doc->>'receiver_nrc'), ''),
    coalesce((p_doc->>'taxable_amount')::NUMERIC, 0), coalesce((p_doc->>'exempt_amount')::NUMERIC, 0),
    coalesce((p_doc->>'non_subject_amount')::NUMERIC, 0), coalesce((p_doc->>'iva_amount')::NUMERIC, 0),
    coalesce((p_doc->>'other_taxes')::NUMERIC, 0), coalesce((p_doc->>'iva_perceived')::NUMERIC, 0),
    coalesce((p_doc->>'iva_withheld')::NUMERIC, 0), coalesce((p_doc->>'income_tax_withheld')::NUMERIC, 0),
    coalesce((p_doc->>'total_amount')::NUMERIC, 0), v_compra, p_raw, p_meta->>'file_name', p_meta->>'mail_from',
    p_meta->>'mail_subject', accounting.ctx_user_name())
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'status', v_status, 'detail', v_detail, 'compra_id', v_compra);
END;
$$;

CREATE OR REPLACE FUNCTION accounting.plan_compra(p_tenant BIGINT, p_id BIGINT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  c         public.compras%ROWTYPE;
  s         accounting.settings;
  v_tipo    TEXT;
  v_nc      BOOLEAN;
  v_cond    INT;
  v_base    NUMERIC(14,2);
  v_otros   NUMERIC(14,2);
  v_perc    NUMERIC(14,2);
  v_riva    NUMERIC(14,2);
  v_renta   NUMERIC(14,2);
  v_payable NUMERIC(14,2);
  v_party   BIGINT;
  v_ref     TEXT;
  v_name    TEXT;
  v_sign    INT;
  v_lines   JSONB := '[]';
  v_dist    JSONB;
  v_dist_total NUMERIC(14,2);
  v_default BIGINT;
  v_credit_role TEXT;
  v_doc     JSONB := NULL;
  v_days    INT;
  v_fin     NUMERIC(14,2);
  v_fin_acc BIGINT;
BEGIN
  SELECT * INTO c FROM public.compras WHERE id = p_id AND tenant_id = p_tenant;
  IF NOT FOUND THEN RETURN jsonb_build_object('skip', 'deleted'); END IF;
  s := accounting.get_settings(p_tenant);
  IF coalesce((c.metadata->>'anulado')::BOOLEAN, false) THEN RETURN jsonb_build_object('skip', 'anulado', 'date', c.fecha); END IF;
  IF s.posting_start_date IS NOT NULL AND c.fecha < s.posting_start_date THEN
    RETURN jsonb_build_object('skip', 'antes_del_inicio', 'date', c.fecha);
  END IF;

  v_tipo := coalesce(NULLIF(c.metadata->>'tipoDocumento', ''), '03');
  v_nc := v_tipo = '05';
  v_sign := CASE WHEN v_nc THEN -1 ELSE 1 END;
  v_cond := coalesce(NULLIF(c.metadata->>'condicionOperacion', '')::INT, 1);
  -- Importación (DUCA): el libro lleva valor en aduana + DAI (anexo), pero a Tesorería solo se le paga
  -- DAI + IVA + otros tributos; el valor de la mercancía es la factura del proveedor del exterior.
  v_base := CASE WHEN c.metadata->>'origen' = 'importacion' THEN accounting.num(c.metadata->>'dai')
                 ELSE coalesce(c.gravado, 0) + coalesce(c.exento, 0) END;
  v_otros := accounting.num(c.metadata->>'otrosTributos');          -- FOVIAL, COTRANS…: van al costo, no son crédito fiscal
  v_perc := accounting.num(c.metadata->>'ivaPercibido');            -- percepción 1% que nos cobraron
  v_riva := accounting.num(c.metadata->>'ivaRetenido');             -- retención 1% que hicimos
  v_renta := accounting.num(c.metadata->>'retencionRenta');         -- renta que retuvimos
  v_payable := v_base + v_otros + coalesce(c.iva, 0) + v_perc - v_riva - v_renta;
  IF v_base + coalesce(c.iva, 0) + v_otros = 0 THEN RETURN jsonb_build_object('skip', 'monto_cero', 'date', c.fecha); END IF;

  v_ref := coalesce(NULLIF(c.metadata->>'numeroControl', ''), NULLIF(c.metadata->>'numeroDocumento', ''), 'Compra ' || c.id);
  v_name := coalesce(NULLIF(btrim(c.proveedor_nombre), ''), 'Proveedor sin nombre');
  v_party := accounting.match_party(p_tenant, coalesce(c.proveedor_nit, c.metadata->>'nit'), c.proveedor_nrc,
                                    coalesce(c.proveedor_dui, c.metadata->>'dui'), v_name);

  -- Distribución: la definida por el contador, o la cuenta del proveedor, o costo/gasto predeterminado
  SELECT jsonb_agg(jsonb_build_object('account_id', account_id, 'amount', v_sign * amount, 'cost_center', cost_center,
                                      'description', coalesce(description, v_name)) ORDER BY id),
         sum(amount)
  INTO v_dist, v_dist_total
  FROM accounting.purchase_distribution WHERE tenant_id = p_tenant AND compra_id = c.id;

  IF v_dist IS NULL OR v_dist_total <> v_base + v_otros THEN
    -- Gasto financiero: los intereses a «Gastos financieros» (o «Gastos bancarios»), el resto al gasto normal
    v_fin := CASE WHEN c.metadata->>'categoria' = 'gasto_financiero' THEN least(accounting.num(c.metadata->>'intereses'), v_base + v_otros) ELSE 0 END;
    v_fin_acc := CASE WHEN v_fin > 0 THEN coalesce(accounting.role_account_opt(p_tenant, 'financial_expense'),
                                                   accounting.role_account_opt(p_tenant, 'bank_charges')) END;
    IF v_fin_acc IS NULL THEN v_fin := 0; END IF;
    v_dist := CASE WHEN v_fin > 0 THEN jsonb_build_array(jsonb_build_object('account_id', v_fin_acc, 'amount', v_sign * v_fin,
                                                   'description', 'Intereses · ' || v_name)) ELSE '[]'::JSONB END;
    IF v_base + v_otros - v_fin <> 0 THEN
      v_default := coalesce(
        (SELECT expense_account_id FROM accounting.party_accounts WHERE tenant_id = p_tenant AND party_id = v_party),
        accounting.role_account(p_tenant, CASE WHEN c.metadata->>'clasificacion' = '1' THEN 'cost_default' ELSE 'expense_default' END));
      v_dist := v_dist || jsonb_build_array(jsonb_build_object('account_id', v_default, 'amount', v_sign * (v_base + v_otros - v_fin),
                                                     'description', coalesce(NULLIF(c.descripcion, ''), v_name)));
    END IF;
  END IF;

  v_credit_role := CASE WHEN v_cond = 2 OR v_nc OR s.purchases_cash_mode = 'payables' THEN 'payables' ELSE 'cash' END;

  v_lines := v_dist || jsonb_build_array(
    jsonb_build_object('account_id', CASE WHEN coalesce(c.iva, 0) <> 0 THEN accounting.role_account(p_tenant, 'vat_credit') END,
                       'amount', v_sign * coalesce(c.iva, 0), 'description', 'IVA crédito fiscal'),
    jsonb_build_object('account_id', CASE WHEN v_perc <> 0 THEN accounting.role_account(p_tenant, 'vat_perceived') END, 'amount', v_sign * v_perc, 'description', 'IVA percibido'),
    jsonb_build_object('account_id', CASE WHEN v_riva <> 0 THEN accounting.role_account(p_tenant, 'vat_withheld') END, 'amount', -v_sign * v_riva, 'description', 'IVA retenido 1%'),
    jsonb_build_object('account_id', CASE WHEN v_renta <> 0 THEN accounting.role_account(p_tenant, 'income_tax_withheld') END, 'amount', -v_sign * v_renta, 'description', 'Renta retenida'),
    jsonb_build_object('account_id', accounting.role_account(p_tenant, v_credit_role), 'amount', -v_sign * v_payable,
                       'party_id', v_party, 'description', v_name)
  );

  IF v_credit_role = 'payables' THEN
    v_days := coalesce((SELECT credit_days FROM accounting.party_accounts WHERE tenant_id = p_tenant AND party_id = v_party),
                       CASE WHEN v_cond = 2 THEN s.default_credit_days ELSE 0 END);
    v_doc := jsonb_build_object('kind', 'cxp', 'party_id', v_party, 'party_name', v_name,
      'party_nit', coalesce(c.proveedor_nit, c.metadata->>'nit', c.proveedor_dui), 'party_nrc', c.proveedor_nrc,
      'doc_type', v_tipo, 'doc_number', v_ref, 'doc_date', c.fecha, 'due_date', c.fecha + v_days,
      'amount', v_sign * v_payable, 'description', NULLIF(c.descripcion, ''));
  END IF;

  RETURN jsonb_build_object('date', c.fecha,
    'concept', CASE WHEN v_nc THEN 'NC de proveedor ' ELSE 'Compra ' END || v_ref || ' · ' || v_name,
    'ref', v_ref, 'lines', accounting.amount_lines(v_lines), 'doc', v_doc);
END;
$$;

/**
 * Estado de cuenta (PDF) de tarjeta o préstamo: registra los intereses del
 * corte como compra tipo 'EC' (sin IVA, fuera del anexo del F-07). El servidor
 * ya validó que el titular es la empresa (p_doc.reject_reason si no).
 * p_doc: {number, bank_name, bank_nit, account, cut_date, interest_total, lines[], other_lines[], reject_reason?}
 */
CREATE OR REPLACE FUNCTION accounting.ingest_financial_statement(p_tenant BIGINT, p_doc JSONB, p_source TEXT, p_meta JSONB)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_num    TEXT := upper(btrim(p_doc->>'number'));
  v_total  NUMERIC(14,2) := round(coalesce((p_doc->>'interest_total')::NUMERIC, 0), 2);
  v_date   DATE := NULLIF(p_doc->>'cut_date', '')::DATE;
  v_nit    TEXT := NULLIF(accounting.digits(p_doc->>'bank_nit'), '');
  v_name   TEXT := coalesce(NULLIF(btrim(p_doc->>'bank_name'), ''), 'Banco');
  v_status TEXT := 'registrado';
  v_detail TEXT;
  v_party  BIGINT;
  v_compra BIGINT;
  v_id     BIGINT;
BEGIN
  IF coalesce(v_num, '') = '' OR v_date IS NULL THEN RAISE EXCEPTION 'Estado de cuenta sin número o fecha de corte' USING ERRCODE = '22023'; END IF;
  IF NULLIF(p_doc->>'reject_reason', '') IS NOT NULL THEN
    v_status := 'rechazado'; v_detail := p_doc->>'reject_reason';
  ELSIF EXISTS (SELECT 1 FROM public.compras WHERE tenant_id = p_tenant AND upper(coalesce(metadata->>'numeroDocumento', '')) = v_num) THEN
    v_status := 'duplicado'; v_detail := 'Ese estado de cuenta ya estaba registrado';
  ELSIF v_total <= 0 THEN
    v_status := 'rechazado'; v_detail := 'El estado de cuenta no tiene intereses cobrados en el mes';
  END IF;

  IF v_status = 'registrado' THEN
    v_party := accounting.match_party(p_tenant, v_nit, NULL, NULL, v_name);
    IF v_party IS NULL AND v_nit IS NOT NULL THEN
      INSERT INTO public.contribuyentes (tenant_id, nombre, nit, giro, tipo, metadata)
      VALUES (p_tenant, v_name, v_nit, 'Bancos', 'Proveedor', '{"origen": "estado_cuenta"}'::JSONB);
    END IF;
    INSERT INTO public.compras (tenant_id, fecha, proveedor_nombre, proveedor_nit, descripcion, gravado, exento, iva, total, metadata)
    VALUES (p_tenant, v_date, v_name, v_nit,
            'Intereses · ' || coalesce(NULLIF(p_doc->>'account', ''), 'estado de cuenta') || ' · corte ' || to_char(v_date, 'DD/MM/YYYY'),
            0, v_total, 0, v_total,
            jsonb_strip_nulls(jsonb_build_object(
              'tipoDocumento', 'EC', 'numeroDocumento', v_num, 'nit', v_nit, 'source', 'imported', 'origen', 'estado_cuenta',
              'clasificacion', '2', 'cuenta', NULLIF(p_doc->>'account', ''), 'fechaCorte', v_date,
              'otrosCargos', p_doc->'other_lines'))
            || accounting.financial_metadata(jsonb_build_object('intereses', v_total, 'detalle', coalesce(p_doc->'lines', '[]'::JSONB))))
    RETURNING id INTO v_compra;
    v_detail := 'Registrado como gasto financiero: intereses $' || to_char(v_total, 'FM999,999,990.00');
  END IF;

  INSERT INTO accounting.received_dtes (tenant_id, source, status, detail, generation_code, document_type, issue_date, issuer_nit,
    issuer_name, exempt_amount, total_amount, compra_id, raw, file_name, mail_from, mail_subject, created_by_name)
  VALUES (p_tenant, p_source, v_status, v_detail, v_num, 'EC', v_date, v_nit, v_name, greatest(v_total, 0), greatest(v_total, 0), v_compra,
    p_doc, p_meta->>'file_name', p_meta->>'mail_from', p_meta->>'mail_subject', accounting.ctx_user_name())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'status', v_status, 'detail', v_detail, 'compra_id', v_compra);
END;
$$;

-- Reclasifica las compras de bancos que ya entraron por el buzón o por JSON
UPDATE public.compras c
   SET metadata = c.metadata || accounting.financial_metadata(f.fin),
       descripcion = CASE WHEN coalesce(c.descripcion, '') LIKE 'Intereses%' THEN c.descripcion
                          ELSE 'Intereses · ' || coalesce(NULLIF(c.descripcion, ''), 'gasto financiero') END
  FROM (SELECT r.compra_id, accounting.financial_breakdown(r.raw) AS fin
          FROM accounting.received_dtes r
         WHERE r.status = 'registrado' AND r.compra_id IS NOT NULL AND r.document_type IN ('01', '03', '11')) f
 WHERE c.id = f.compra_id AND f.fin IS NOT NULL AND coalesce(c.metadata->>'categoria', '') <> 'gasto_financiero';
