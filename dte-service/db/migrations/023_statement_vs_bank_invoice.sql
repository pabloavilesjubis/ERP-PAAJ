-- =============================================================================
-- 023_statement_vs_bank_invoice — Estado de cuenta vs. factura del banco.
--
-- Si el banco ya emitió factura (DTE) de intereses en el mes del corte, el
-- estado de cuenta no se registra (los intereses ya están con su DTE). Si el
-- estado de cuenta entró primero y después llega la factura del mes, el estado
-- de cuenta se anula (y su asiento se revierte). Tarjetas y préstamos se comparan
-- por separado: la factura del hipotecario no reemplaza el estado de la tarjeta.
-- =============================================================================

/** ¿Una compra de gasto financiero (DTE) es de tarjeta de crédito? */
CREATE OR REPLACE FUNCTION accounting.fin_is_card(p_descripcion TEXT, p_cuenta TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(p_cuenta, '') ILIKE 'Tarjeta%' OR coalesce(p_descripcion, '') ~* 'TARJ'
$$;

/** Factura de intereses del banco (no estado de cuenta) del mismo tipo en el mes. */
CREATE OR REPLACE FUNCTION accounting.bank_invoice_for_month(p_tenant BIGINT, p_bank_key TEXT, p_bank_nit TEXT, p_month DATE, p_card BOOLEAN)
RETURNS BIGINT LANGUAGE sql STABLE AS $$
  SELECT c.id FROM public.compras c
   WHERE c.tenant_id = p_tenant
     AND c.metadata->>'categoria' = 'gasto_financiero'
     AND coalesce(c.metadata->>'tipoDocumento', '') <> 'EC'
     AND NOT coalesce((c.metadata->>'anulado')::BOOLEAN, false)
     AND date_trunc('month', c.fecha) = date_trunc('month', p_month)
     AND ((p_bank_nit IS NOT NULL AND accounting.digits(c.proveedor_nit) = p_bank_nit)
          OR (coalesce(p_bank_key, '') NOT IN ('', 'BANCO') AND upper(c.proveedor_nombre) LIKE '%' || p_bank_key || '%'))
     AND accounting.fin_is_card(c.descripcion, NULL) = p_card
   ORDER BY c.fecha LIMIT 1
$$;

CREATE OR REPLACE FUNCTION accounting.ingest_financial_statement(p_tenant BIGINT, p_doc JSONB, p_source TEXT, p_meta JSONB)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_num    TEXT := upper(btrim(p_doc->>'number'));
  v_total  NUMERIC(14,2) := round(coalesce((p_doc->>'interest_total')::NUMERIC, 0), 2);
  v_date   DATE := NULLIF(p_doc->>'cut_date', '')::DATE;
  v_nit    TEXT := NULLIF(accounting.digits(p_doc->>'bank_nit'), '');
  v_name   TEXT := coalesce(NULLIF(btrim(p_doc->>'bank_name'), ''), 'Banco');
  v_key    TEXT := split_part(upper(btrim(p_doc->>'number')), '-', 2);
  v_card   BOOLEAN := coalesce(p_doc->>'account', '') ILIKE 'Tarjeta%';
  v_status TEXT := 'registrado';
  v_detail TEXT;
  v_party  BIGINT;
  v_compra BIGINT;
  v_inv    BIGINT;
  v_id     BIGINT;
BEGIN
  IF coalesce(v_num, '') = '' OR v_date IS NULL THEN RAISE EXCEPTION 'Estado de cuenta sin número o fecha de corte' USING ERRCODE = '22023'; END IF;
  IF NULLIF(p_doc->>'reject_reason', '') IS NOT NULL THEN
    v_status := 'rechazado'; v_detail := p_doc->>'reject_reason';
  ELSIF EXISTS (SELECT 1 FROM public.compras WHERE tenant_id = p_tenant AND upper(coalesce(metadata->>'numeroDocumento', '')) = v_num) THEN
    v_status := 'duplicado'; v_detail := 'Ese estado de cuenta ya estaba registrado';
  ELSIF v_total <= 0 THEN
    v_status := 'rechazado'; v_detail := 'El estado de cuenta no tiene intereses cobrados en el mes';
  ELSE
    v_inv := accounting.bank_invoice_for_month(p_tenant, v_key, v_nit, v_date, v_card);
    IF v_inv IS NOT NULL THEN
      v_status := 'duplicado';
      v_detail := 'El banco ya emitió factura de intereses ' || CASE WHEN v_card THEN 'de tarjeta ' ELSE '' END
                  || 'en ' || to_char(v_date, 'MM/YYYY') || ' (compra #' || v_inv || '): no se considera el estado de cuenta';
    END IF;
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

/**
 * Llegó la factura de intereses del banco: anula los estados de cuenta del
 * mismo banco, tipo (tarjeta / préstamo) y mes. Devuelve cuántos anuló.
 */
CREATE OR REPLACE FUNCTION accounting.supersede_statements(p_tenant BIGINT, p_compra BIGINT)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
  d  public.compras%ROWTYPE;
  n  INT;
BEGIN
  SELECT * INTO d FROM public.compras WHERE id = p_compra AND tenant_id = p_tenant;
  IF NOT FOUND OR d.metadata->>'categoria' IS DISTINCT FROM 'gasto_financiero' OR d.metadata->>'tipoDocumento' = 'EC' THEN RETURN 0; END IF;
  UPDATE public.compras e
     SET metadata = e.metadata || jsonb_build_object('anulado', true, 'fechaAnulacion', accounting.today(),
                     'motivoAnulacion', 'El banco emitió factura de intereses del mes (compra #' || d.id || ')')
   WHERE e.tenant_id = p_tenant AND e.metadata->>'tipoDocumento' = 'EC'
     AND NOT coalesce((e.metadata->>'anulado')::BOOLEAN, false)
     AND date_trunc('month', e.fecha) = date_trunc('month', d.fecha)
     AND accounting.fin_is_card(NULL, e.metadata->>'cuenta') = accounting.fin_is_card(d.descripcion, NULL)
     AND ((e.proveedor_nit IS NOT NULL AND e.proveedor_nit = accounting.digits(d.proveedor_nit))
          OR (split_part(upper(e.metadata->>'numeroDocumento'), '-', 2) NOT IN ('', 'BANCO')
              AND upper(d.proveedor_nombre) LIKE '%' || split_part(upper(e.metadata->>'numeroDocumento'), '-', 2) || '%'));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
