-- =============================================================================
-- 013_imports — Importaciones (DUCA) (F6). Portado de ChuchoWash (0050) y
-- simplificado: la DUCA se registra en el libro de compras como documento
-- tipo 12 de la Dirección General de Tesorería (columna L = valor en aduana +
-- DAI, IVA = crédito fiscal), y su asiento lleva solo lo pagado en aduana:
-- Debe cuenta destino (inventario / activo / costo) por DAI + otros tributos
-- (VTS, ITS…: costo, nunca IVA), Debe IVA crédito fiscal, Haber Tesorería
-- (CxP, se paga contra el banco). La factura del proveedor del exterior (FOB,
-- flete) se registra aparte. Una IA puede leer el PDF de la DUCA (opcional,
-- ANTHROPIC_API_KEY); el contador revisa las validaciones y confirma.
-- =============================================================================

CREATE TABLE accounting.imports (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  duca_number       TEXT NOT NULL,
  acceptance_date   DATE NOT NULL,
  exporter_name     TEXT,
  exporter_country  TEXT,
  invoice_number    TEXT,
  fob               NUMERIC(14,2) NOT NULL DEFAULT 0,
  freight           NUMERIC(14,2) NOT NULL DEFAULT 0,
  insurance         NUMERIC(14,2) NOT NULL DEFAULT 0,
  other_costs       NUMERIC(14,2) NOT NULL DEFAULT 0,
  customs_value     NUMERIC(14,2) NOT NULL,
  dai               NUMERIC(14,2) NOT NULL DEFAULT 0,
  iva               NUMERIC(14,2) NOT NULL DEFAULT 0,
  other_taxes       NUMERIC(14,2) NOT NULL DEFAULT 0,
  destination_account_id BIGINT NOT NULL REFERENCES accounting.accounts(id),
  data              JSONB NOT NULL DEFAULT '{}',
  read_by_ai        BOOLEAN NOT NULL DEFAULT false,
  compra_id         BIGINT REFERENCES public.compras(id) ON DELETE SET NULL,
  created_by_name   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, duca_number)
);

-- Proveedor de las DUCA: Dirección General de Tesorería (NIT 0614-010814-006-6)
CREATE OR REPLACE FUNCTION accounting.ensure_treasury(p_tenant BIGINT)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  v BIGINT;
BEGIN
  SELECT id INTO v FROM public.contribuyentes WHERE tenant_id = p_tenant AND regexp_replace(coalesce(nit, ''), '\D', '', 'g') = '06140108140066';
  IF v IS NULL THEN
    INSERT INTO public.contribuyentes (tenant_id, nombre, nit, tipo, metadata)
    VALUES (p_tenant, 'DIRECCIÓN GENERAL DE TESORERÍA', '06140108140066', 'Proveedor', '{"origen": "importaciones"}')
    RETURNING id INTO v;
  END IF;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION accounting.register_import(p_tenant BIGINT, p JSONB, p_destination BIGINT, p_read_by_ai BOOLEAN)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  v_cv     NUMERIC(14,2) := round((p->>'customs_value')::NUMERIC, 2);
  v_dai    NUMERIC(14,2) := round(coalesce((p->>'dai')::NUMERIC, 0), 2);
  v_iva    NUMERIC(14,2) := round(coalesce((p->>'iva')::NUMERIC, 0), 2);
  v_other  NUMERIC(14,2) := round(coalesce((p->>'other_taxes')::NUMERIC, 0), 2);
  v_cif    NUMERIC(14,2);
  v_compra BIGINT;
  v_id     BIGINT;
  v_acc    accounting.accounts%ROWTYPE;
BEGIN
  IF coalesce(btrim(p->>'duca_number'), '') !~ '^\d{6,20}$' THEN RAISE EXCEPTION 'El número de DUCA debe tener solo dígitos' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM accounting.imports WHERE tenant_id = p_tenant AND duca_number = btrim(p->>'duca_number')) THEN
    RAISE EXCEPTION 'La DUCA % ya está registrada', p->>'duca_number' USING ERRCODE = '22023';
  END IF;
  -- La ley: valor en aduana = FOB + flete + seguro + otros; IVA = 13 % de (valor en aduana + DAI)
  v_cif := round(coalesce((p->>'fob')::NUMERIC, 0) + coalesce((p->>'freight')::NUMERIC, 0) + coalesce((p->>'insurance')::NUMERIC, 0)
                 + coalesce((p->>'other_costs')::NUMERIC, 0), 2);
  IF abs(v_cif - v_cv) > 0.05 THEN
    RAISE EXCEPTION 'El valor en aduana % no es FOB + flete + seguro + otros (%)', v_cv, v_cif USING ERRCODE = '22023';
  END IF;
  IF abs(round((v_cv + v_dai) * 0.13, 2) - v_iva) > greatest(0.05, jsonb_array_length(coalesce(p->'lines', '[]')) * 0.02) THEN
    RAISE EXCEPTION 'El IVA % no es el 13%% de valor en aduana + DAI (%)', v_iva, round((v_cv + v_dai) * 0.13, 2) USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_acc FROM accounting.accounts WHERE id = p_destination AND tenant_id = p_tenant;
  IF NOT FOUND OR NOT v_acc.allows_movements THEN RAISE EXCEPTION 'Elige la cuenta destino (inventario, activo o costo)' USING ERRCODE = '22023'; END IF;

  PERFORM accounting.ensure_treasury(p_tenant);
  INSERT INTO public.compras (tenant_id, fecha, proveedor_nombre, proveedor_nit, descripcion, gravado, exento, iva, total, metadata)
  VALUES (p_tenant, (p->>'acceptance_date')::DATE, 'DIRECCIÓN GENERAL DE TESORERÍA', '06140108140066',
          'Importación DUCA ' || btrim(p->>'duca_number') || coalesce(' · ' || NULLIF(p->>'exporter_name', ''), ''),
          v_cv + v_dai, 0, v_iva, v_cv + v_dai + v_iva + v_other,
          jsonb_strip_nulls(jsonb_build_object('claseDocumento', '3', 'tipoDocumento', '12', 'numeroDocumento', btrim(p->>'duca_number'),
            'origen', 'importacion', 'dai', to_char(v_dai, 'FM999999990.00'), 'clasificacion', '1', 'tipoOperacion', '1',
            'otrosTributos', CASE WHEN v_other > 0 THEN to_char(v_other, 'FM999999990.00') END, 'source', 'manual')))
  RETURNING id INTO v_compra;

  IF v_dai + v_other > 0 THEN
    INSERT INTO accounting.purchase_distribution (tenant_id, compra_id, account_id, amount, description)
    VALUES (p_tenant, v_compra, p_destination, v_dai + v_other, 'DAI y tributos de importación');
  END IF;
  -- El trigger contabilizó al insertar (sin la distribución): recontabiliza con ella
  IF coalesce((SELECT auto_post FROM accounting.settings WHERE tenant_id = p_tenant), false) THEN
    PERFORM accounting.try_sync_document(p_tenant, 'compras', v_compra);
  END IF;

  INSERT INTO accounting.imports (tenant_id, duca_number, acceptance_date, exporter_name, exporter_country, invoice_number, fob, freight,
    insurance, other_costs, customs_value, dai, iva, other_taxes, destination_account_id, data, read_by_ai, compra_id, created_by_name)
  VALUES (p_tenant, btrim(p->>'duca_number'), (p->>'acceptance_date')::DATE, NULLIF(p->>'exporter_name', ''), NULLIF(p->>'exporter_country', ''),
    NULLIF(p->>'invoice_number', ''), coalesce((p->>'fob')::NUMERIC, 0), coalesce((p->>'freight')::NUMERIC, 0),
    coalesce((p->>'insurance')::NUMERIC, 0), coalesce((p->>'other_costs')::NUMERIC, 0), v_cv, v_dai, v_iva, v_other, p_destination,
    coalesce(p->'data', '{}'), coalesce(p_read_by_ai, false), v_compra, accounting.ctx_user_name())
  RETURNING id INTO v_id;
  RETURN v_id;
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
    v_default := coalesce(
      (SELECT expense_account_id FROM accounting.party_accounts WHERE tenant_id = p_tenant AND party_id = v_party),
      accounting.role_account(p_tenant, CASE WHEN c.metadata->>'clasificacion' = '1' THEN 'cost_default' ELSE 'expense_default' END));
    v_dist := jsonb_build_array(jsonb_build_object('account_id', v_default, 'amount', v_sign * (v_base + v_otros),
                                                   'description', coalesce(NULLIF(c.descripcion, ''), v_name)));
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

