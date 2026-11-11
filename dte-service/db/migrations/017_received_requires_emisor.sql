-- =============================================================================
-- 017_received_requires_emisor — DTEs recibidos: validar siempre el receptor.
--
-- Si la empresa no tenía datos fiscales (tenant_emisor) la validación "¿es
-- para esta empresa?" se saltaba y cualquier DTE del buzón entraba como
-- compra, incluidas las copias de las ventas que la propia empresa emite.
-- Ahora: sin datos fiscales se rechaza, y un DTE cuyo emisor es la propia
-- empresa también.
-- =============================================================================

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
    ELSIF (NULLIF(accounting.digits(p_doc->>'receiver_nit'), '') IS NOT NULL OR NULLIF(accounting.digits(p_doc->>'receiver_nrc'), '') IS NOT NULL)
       AND accounting.digits(p_doc->>'receiver_nit') <> accounting.digits(v_emisor.mh_nit)
       AND accounting.digits(p_doc->>'receiver_nrc') <> accounting.digits(v_emisor.emisor_nrc) THEN
      v_status := 'rechazado';
      v_detail := 'El receptor del DTE (' || coalesce(p_doc->>'receiver_name', '') || ') no es esta empresa';
    END IF;
  END IF;
  IF v_status = 'registrado' AND v_type = '01' THEN
    v_status := 'rechazado'; v_detail := 'Factura de consumidor final: no da crédito fiscal (pide CCF al proveedor)';
  END IF;
  IF v_status = 'registrado' AND v_stamp IS NULL THEN
    v_status := 'rechazado'; v_detail := 'El DTE no tiene sello de recepción del MH';
  END IF;

  IF v_status = 'registrado' THEN
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
            NULLIF(v_nit, ''), NULLIF(v_nrc, ''), NULLIF(p_doc->>'description', ''),
            coalesce((p_doc->>'taxable_amount')::NUMERIC, 0),
            coalesce((p_doc->>'exempt_amount')::NUMERIC, 0) + coalesce((p_doc->>'non_subject_amount')::NUMERIC, 0),
            coalesce((p_doc->>'iva_amount')::NUMERIC, 0), coalesce((p_doc->>'total_amount')::NUMERIC, 0),
            jsonb_strip_nulls(jsonb_build_object(
              'claseDocumento', '4', 'tipoDocumento', v_type, 'numeroDocumento', v_code, 'codigoGeneracion', v_code,
              'numeroControl', v_ctrl, 'selloRecibido', v_stamp, 'nit', NULLIF(v_nit, ''), 'source', 'imported', 'origen', 'buzon',
              'tipoOperacion', '1', 'clasificacion', '2',
              'ivaPercibido', CASE WHEN (p_doc->>'iva_perceived')::NUMERIC > 0 THEN to_char((p_doc->>'iva_perceived')::NUMERIC, 'FM999999990.00') END,
              'ivaRetenido', CASE WHEN (p_doc->>'iva_withheld')::NUMERIC > 0 THEN to_char((p_doc->>'iva_withheld')::NUMERIC, 'FM999999990.00') END,
              'retencionRenta', CASE WHEN (p_doc->>'income_tax_withheld')::NUMERIC > 0 THEN to_char((p_doc->>'income_tax_withheld')::NUMERIC, 'FM999999990.00') END,
              'otrosTributos', CASE WHEN (p_doc->>'other_taxes')::NUMERIC > 0 THEN to_char((p_doc->>'other_taxes')::NUMERIC, 'FM999999990.00') END)))
    RETURNING id INTO v_compra;
    v_detail := 'Registrado en el libro de compras';
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
