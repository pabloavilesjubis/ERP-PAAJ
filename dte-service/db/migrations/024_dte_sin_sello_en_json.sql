-- =============================================================================
-- 024_dte_sin_sello_en_json — DTEs cuyo JSON no trae el sello de recepción.
--
-- Algunos emisores (SAC Multimoney, entre otros) mandan el JSON sin el sello y
-- lo imprimen solo en el PDF. Ahora:
--  * El servidor toma el sello del PDF del mismo correo o subido junto al JSON.
--  * Si no hay PDF, un DTE de producción (ambiente 01) se registra marcado
--    metadata.selloPendiente; los de pruebas se siguen rechazando.
--  * Los correos con DTEs rechazados se vuelven a revisar (quedan como error
--    para que «Revisar meses» los procese otra vez; los duplicados no se repiten).
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
  -- Sin sello en el JSON: algunos emisores (p. ej. financieras) solo lo imprimen en el PDF. Un DTE del
  -- ambiente de producción (01) se registra marcado «sello pendiente»; uno de pruebas se rechaza.
  IF v_status = 'registrado' AND v_stamp IS NULL AND coalesce(p_raw->'identificacion'->>'ambiente', '') <> '01' THEN
    v_status := 'rechazado'; v_detail := 'El DTE no tiene sello de recepción del MH y no es del ambiente de producción';
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
            || coalesce(accounting.financial_metadata(v_fin), '{}'::JSONB)
            || CASE WHEN v_stamp IS NULL THEN '{"selloPendiente": true}'::JSONB ELSE '{}'::JSONB END)
    RETURNING id INTO v_compra;
    v_detail := CASE WHEN v_fin IS NOT NULL THEN 'Registrado como gasto financiero: intereses $' || to_char((v_fin->>'intereses')::NUMERIC, 'FM999,999,990.00')
                     WHEN v_credito THEN 'Registrado en el libro de compras'
                     ELSE 'Registrado como compra sin crédito fiscal (el IVA no se deduce)' END;
    IF v_stamp IS NULL THEN v_detail := v_detail || ' · el JSON no trae sello del MH: revísalo en el PDF'; END IF;
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

UPDATE accounting.mail_messages SET status = 'error', pdf_checked = false
 WHERE status = 'procesado' AND dte_count > 0 AND detail ~ ': rechazado';
