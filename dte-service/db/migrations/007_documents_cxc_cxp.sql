-- =============================================================================
-- 007_documents_cxc_cxp — Ventas y compras contabilizadas, CxC y CxP (F2).
--
-- "La contabilidad es consecuencia de la operación" (principio de ChuchoWash):
--  * Un trigger sobre public.ventas y public.compras contabiliza cada
--    documento al crearse, editarse o borrarse (accounting.sync_document).
--  * Si contabilizar falla (falta una cuenta, período cerrado…), la venta o
--    compra NO se bloquea: el error queda en accounting.document_postings y el
--    contador lo ve en Contabilidad → Integración, lo corrige y reintenta.
--  * Arranca apagado (settings.auto_post = false) con fecha de inicio: así el
--    histórico de una empresa no se contabiliza solo; el contador decide desde
--    cuándo y lanza "contabilizar pendientes".
--
-- Auxiliares (subledger) de CxC / CxP en accounting.documents: cada factura
-- al crédito (o toda compra, según configuración) es un documento con saldo.
-- Los cobros y pagos (accounting.payments) se aplican a uno o varios
-- documentos; el sobrante queda como anticipo.
-- =============================================================================

-- ── Configuración de integración por empresa ──
CREATE TABLE accounting.settings (
  tenant_id            BIGINT PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  auto_post            BOOLEAN NOT NULL DEFAULT false,
  posting_start_date   DATE,
  -- A dónde va el debe de una venta de contado: caja, banco o CxC (si se liquida contra depósitos)
  sales_cash_role      TEXT NOT NULL DEFAULT 'cash' CHECK (sales_cash_role IN ('cash', 'bank', 'receivables')),
  -- Compras de contado: a CxP (se pagan contra el estado de cuenta) o directo a caja
  purchases_cash_mode  TEXT NOT NULL DEFAULT 'payables' CHECK (purchases_cash_mode IN ('payables', 'cash')),
  default_credit_days  INT NOT NULL DEFAULT 30 CHECK (default_credit_days BETWEEN 0 AND 365),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by           TEXT
);

CREATE OR REPLACE FUNCTION accounting.get_settings(p_tenant BIGINT)
RETURNS accounting.settings LANGUAGE plpgsql AS $$
DECLARE
  v accounting.settings;
BEGIN
  SELECT * INTO v FROM accounting.settings WHERE tenant_id = p_tenant;
  IF NOT FOUND THEN
    INSERT INTO accounting.settings (tenant_id) VALUES (p_tenant) ON CONFLICT DO NOTHING;
    SELECT * INTO v FROM accounting.settings WHERE tenant_id = p_tenant;
  END IF;
  RETURN v;
END;
$$;

-- ── Cuentas sugeridas por tercero (gasto/costo de un proveedor, ingreso de un cliente) ──
CREATE TABLE accounting.party_accounts (
  tenant_id          BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  party_id           BIGINT NOT NULL REFERENCES public.contribuyentes(id) ON DELETE CASCADE,
  expense_account_id BIGINT REFERENCES accounting.accounts(id),
  income_account_id  BIGINT REFERENCES accounting.accounts(id),
  credit_days        INT CHECK (credit_days BETWEEN 0 AND 365),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, party_id)
);

-- ── Distribución contable de una compra (si el contador la divide en varias cuentas) ──
CREATE TABLE accounting.purchase_distribution (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  compra_id   BIGINT NOT NULL REFERENCES public.compras(id) ON DELETE CASCADE,
  account_id  BIGINT NOT NULL REFERENCES accounting.accounts(id),
  amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  cost_center TEXT,
  description TEXT
);
CREATE INDEX idx_purchase_distribution ON accounting.purchase_distribution(tenant_id, compra_id);

-- ── Estado de contabilización de cada documento operativo ──
CREATE TABLE accounting.document_postings (
  tenant_id   BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  module      TEXT NOT NULL CHECK (module IN ('ventas', 'compras')),
  source_id   BIGINT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('contabilizado', 'error', 'omitido')),
  entry_id    BIGINT REFERENCES accounting.journal_entries(id),
  fingerprint TEXT,
  message     TEXT,
  doc_date    DATE,
  doc_ref     TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, module, source_id)
);
CREATE INDEX idx_document_postings_status ON accounting.document_postings(tenant_id, status);

-- =============================================================================
-- AUXILIARES CxC / CxP
-- =============================================================================
CREATE TABLE accounting.documents (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('cxc', 'cxp')),
  source_module TEXT NOT NULL CHECK (source_module IN ('ventas', 'compras', 'manual')),
  source_id     TEXT NOT NULL,
  party_id      BIGINT REFERENCES public.contribuyentes(id),
  party_name    TEXT NOT NULL,
  party_nit     TEXT,
  party_nrc     TEXT,
  doc_type      TEXT,                         -- 01 FCF, 03 CCF, 05 NC, 14 FSE, OTRO…
  doc_number    TEXT,
  doc_date      DATE NOT NULL,
  due_date      DATE NOT NULL,
  amount        NUMERIC(14,2) NOT NULL,       -- negativo = nota de crédito (resta del saldo)
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'vigente' CHECK (status IN ('vigente', 'anulado')),
  entry_id      BIGINT REFERENCES accounting.journal_entries(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, source_module, source_id)
);
CREATE INDEX idx_documents_party ON accounting.documents(tenant_id, kind, party_id);
CREATE INDEX idx_documents_date ON accounting.documents(tenant_id, kind, doc_date);

CREATE TABLE accounting.payments (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('cobro', 'pago')),
  number          BIGINT NOT NULL,
  payment_date    DATE NOT NULL,
  party_id        BIGINT REFERENCES public.contribuyentes(id),
  party_name      TEXT NOT NULL,
  party_key       TEXT NOT NULL,
  method          TEXT NOT NULL CHECK (method IN ('efectivo', 'transferencia', 'cheque', 'tarjeta', 'compensacion', 'otro')),
  fund_account_id BIGINT REFERENCES accounting.accounts(id),     -- caja/banco de donde sale o a donde entra
  amount          NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  unapplied       NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (unapplied >= 0),   -- queda como anticipo
  reference       TEXT,
  notes           TEXT,
  status          TEXT NOT NULL DEFAULT 'vigente' CHECK (status IN ('vigente', 'anulado')),
  entry_id        BIGINT REFERENCES accounting.journal_entries(id),
  created_by      TEXT,
  created_by_name TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  voided_at       TIMESTAMPTZ,
  voided_by_name  TEXT,
  void_reason     TEXT,
  UNIQUE (tenant_id, kind, number)
);
CREATE INDEX idx_payments_party ON accounting.payments(tenant_id, kind, party_key);

CREATE TABLE accounting.payment_allocations (
  id          BIGSERIAL PRIMARY KEY,
  payment_id  BIGINT NOT NULL REFERENCES accounting.payments(id) ON DELETE CASCADE,
  document_id BIGINT NOT NULL REFERENCES accounting.documents(id),
  amount      NUMERIC(14,2) NOT NULL CHECK (amount <> 0)
);
CREATE INDEX idx_payment_allocations_doc ON accounting.payment_allocations(document_id);
CREATE INDEX idx_payment_allocations_payment ON accounting.payment_allocations(payment_id);

/** Llave de agrupación de un tercero: id del catálogo, o NIT/NRC/nombre si no está registrado. */
CREATE OR REPLACE FUNCTION accounting.party_key(p_party_id BIGINT, p_nit TEXT, p_nrc TEXT, p_name TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_party_id IS NOT NULL THEN 'id:' || p_party_id
    WHEN NULLIF(regexp_replace(coalesce(p_nit, ''), '\D', '', 'g'), '') IS NOT NULL THEN 'nit:' || regexp_replace(p_nit, '\D', '', 'g')
    WHEN NULLIF(regexp_replace(coalesce(p_nrc, ''), '\D', '', 'g'), '') IS NOT NULL THEN 'nrc:' || regexp_replace(p_nrc, '\D', '', 'g')
    ELSE 'name:' || upper(btrim(coalesce(p_name, '')))
  END;
$$;

ALTER TABLE accounting.documents ADD COLUMN party_key TEXT
  GENERATED ALWAYS AS (accounting.party_key(party_id, party_nit, party_nrc, party_name)) STORED;
CREATE INDEX idx_documents_party_key ON accounting.documents(tenant_id, kind, party_key);

/** Saldo pendiente de cada documento (monto − aplicaciones de cobros/pagos vigentes). */
CREATE OR REPLACE VIEW accounting.document_balances AS
SELECT d.*,
       coalesce((SELECT sum(a.amount) FROM accounting.payment_allocations a
                 JOIN accounting.payments p ON p.id = a.payment_id
                 WHERE a.document_id = d.id AND p.status = 'vigente'), 0)::NUMERIC(14,2) AS applied,
       (d.amount - coalesce((SELECT sum(a.amount) FROM accounting.payment_allocations a
                 JOIN accounting.payments p ON p.id = a.payment_id
                 WHERE a.document_id = d.id AND p.status = 'vigente'), 0))::NUMERIC(14,2) AS balance
FROM accounting.documents d;

/** Busca el tercero en Contribuyentes por NIT, NRC, DUI o nombre exacto (no crea). */
CREATE OR REPLACE FUNCTION accounting.match_party(p_tenant BIGINT, p_nit TEXT, p_nrc TEXT, p_dui TEXT, p_name TEXT)
RETURNS BIGINT LANGUAGE sql STABLE AS $$
  SELECT id FROM public.contribuyentes c
  WHERE c.tenant_id = p_tenant AND (
       (NULLIF(regexp_replace(coalesce(p_nit, ''), '\D', '', 'g'), '') IS NOT NULL
          AND regexp_replace(coalesce(c.nit, ''), '\D', '', 'g') = regexp_replace(p_nit, '\D', '', 'g'))
    OR (NULLIF(regexp_replace(coalesce(p_nrc, ''), '\D', '', 'g'), '') IS NOT NULL
          AND regexp_replace(coalesce(c.nrc, ''), '\D', '', 'g') = regexp_replace(p_nrc, '\D', '', 'g'))
    OR (NULLIF(regexp_replace(coalesce(p_dui, ''), '\D', '', 'g'), '') IS NOT NULL
          AND regexp_replace(coalesce(c.dui, ''), '\D', '', 'g') = regexp_replace(p_dui, '\D', '', 'g'))
    OR (NULLIF(btrim(coalesce(p_name, '')), '') IS NOT NULL AND upper(btrim(c.nombre)) = upper(btrim(p_name))))
  ORDER BY (regexp_replace(coalesce(c.nit, ''), '\D', '', 'g') = regexp_replace(coalesce(p_nit, ''), '\D', '', 'g')) DESC, c.id
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION accounting.num(p TEXT) RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' THEN round(p::NUMERIC, 2) ELSE 0 END;
$$;

-- =============================================================================
-- CONSTRUCCIÓN DEL ASIENTO DE UNA VENTA / COMPRA
-- Devuelve un plan: {skip, date, concept, ref, lines[], doc{…}|null}
-- =============================================================================
CREATE OR REPLACE FUNCTION accounting.plan_venta(p_tenant BIGINT, p_id BIGINT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v        public.ventas%ROWTYPE;
  s        accounting.settings;
  d        public.dtes%ROWTYPE;
  v_tipo   TEXT;
  v_nc     BOOLEAN;
  v_cond   INT;
  v_grav   NUMERIC(14,2);
  v_exen   NUMERIC(14,2);
  v_iva    NUMERIC(14,2);
  v_rrenta NUMERIC(14,2);
  v_riva   NUMERIC(14,2);
  v_total  NUMERIC(14,2);
  v_party  BIGINT;
  v_ref    TEXT;
  v_name   TEXT;
  v_debit_role TEXT;
  v_income BIGINT;
  v_lines  JSONB := '[]';
  v_sign   INT;
  v_doc    JSONB := NULL;
  v_days   INT;
BEGIN
  SELECT * INTO v FROM public.ventas WHERE id = p_id AND tenant_id = p_tenant;
  IF NOT FOUND THEN RETURN jsonb_build_object('skip', 'deleted'); END IF;
  s := accounting.get_settings(p_tenant);
  IF coalesce((v.metadata->>'anulado')::BOOLEAN, false) THEN RETURN jsonb_build_object('skip', 'anulado', 'date', v.fecha); END IF;
  IF s.posting_start_date IS NOT NULL AND v.fecha < s.posting_start_date THEN
    RETURN jsonb_build_object('skip', 'antes_del_inicio', 'date', v.fecha);
  END IF;

  IF v.dte_id IS NOT NULL THEN SELECT * INTO d FROM public.dtes WHERE id = v.dte_id; END IF;
  v_tipo := coalesce(NULLIF(v.metadata->>'tipoDocumento', ''), d.tipo_dte, CASE WHEN v.kind = 'consumidor' THEN '01' ELSE '03' END);
  v_nc := v_tipo = '05';
  v_cond := coalesce(NULLIF(d.dte_json->'resumen'->>'condicionOperacion', '')::INT,
                     NULLIF(v.metadata->>'condicionOperacion', '')::INT, 1);

  IF v.kind = 'consumidor' AND v.gravado IS NULL THEN
    -- FCF: el monto incluye IVA
    v_total := coalesce(v.monto, 0);
    v_grav := round(v_total / 1.13, 2);
    v_iva := v_total - v_grav;
    v_exen := 0;
  ELSE
    v_grav := coalesce(v.gravado, 0);
    v_exen := coalesce(v.exento, 0);
    v_iva := coalesce(v.iva, round(v_grav * 0.13, 2));
    IF v.kind = 'consumidor' THEN v_iva := coalesce(v.iva, 0); END IF;
    v_total := v_grav + v_exen + v_iva;
  END IF;
  v_rrenta := accounting.num(v.metadata->>'retencionRenta');
  v_riva := coalesce(accounting.num(d.dte_json->'resumen'->>'ivaRete1'), 0) + accounting.num(v.metadata->>'ivaRetenido');
  IF v_total = 0 THEN RETURN jsonb_build_object('skip', 'monto_cero', 'date', v.fecha); END IF;

  v_ref := coalesce(NULLIF(v.metadata->>'numeroControl', ''), d.numero_control, NULLIF(v.metadata->>'numeroDocumento', ''),
                    NULLIF(v.metadata->>'codigoGeneracion', ''), 'Venta ' || v.id);
  v_name := coalesce(NULLIF(btrim(v.cliente_nombre), ''), NULLIF(btrim(v.metadata->>'cliente'), ''),
                     CASE WHEN v.kind = 'consumidor' THEN 'Consumidor final' ELSE 'Cliente sin nombre' END);
  v_party := accounting.match_party(p_tenant, coalesce(v.cliente_nit, v.metadata->>'nit'), v.cliente_nrc, NULL,
                                    CASE WHEN v.kind = 'contribuyente' THEN v_name END);

  -- Debe: crédito → CxC; contado → según configuración (caja / banco / CxC)
  v_debit_role := CASE WHEN v_cond = 2 OR v_nc THEN 'receivables' ELSE s.sales_cash_role END;
  v_income := coalesce((SELECT income_account_id FROM accounting.party_accounts WHERE tenant_id = p_tenant AND party_id = v_party),
                       accounting.role_account(p_tenant, 'income_sales'));
  v_sign := CASE WHEN v_nc THEN -1 ELSE 1 END;

  -- Neto a cobrar = total − retenciones que nos hace el cliente
  v_lines := jsonb_build_array(
    jsonb_build_object('role', v_debit_role, 'account_id', accounting.role_account(p_tenant, v_debit_role),
                       'amount', v_sign * (v_total - v_rrenta - v_riva), 'party_id', v_party, 'description', v_name),
    jsonb_build_object('account_id', CASE WHEN v_riva <> 0 THEN accounting.role_account(p_tenant, 'vat_withheld_by_customers') END,
                       'amount', v_sign * v_riva, 'description', 'IVA retenido por el cliente'),
    jsonb_build_object('account_id', CASE WHEN v_rrenta <> 0 THEN accounting.role_account(p_tenant, 'income_tax_withheld_by_customers') END,
                       'amount', v_sign * v_rrenta, 'description', 'Renta retenida por el cliente'),
    jsonb_build_object('account_id', CASE WHEN v_nc THEN coalesce(accounting.role_account_opt(p_tenant, 'sales_returns'), v_income) ELSE v_income END,
                       'amount', -v_sign * v_grav, 'description', CASE WHEN v_nc THEN 'Nota de crédito' ELSE 'Ventas gravadas' END),
    jsonb_build_object('account_id', CASE WHEN v_exen <> 0 THEN accounting.role_account(p_tenant, 'income_exempt') END,
                       'amount', -v_sign * v_exen, 'description', 'Ventas exentas'),
    jsonb_build_object('account_id', CASE WHEN v_iva <> 0 THEN accounting.role_account(p_tenant, 'vat_debit') END,
                       'amount', -v_sign * v_iva, 'description', 'IVA débito fiscal')
  );

  IF v_debit_role = 'receivables' THEN
    v_days := coalesce((SELECT credit_days FROM accounting.party_accounts WHERE tenant_id = p_tenant AND party_id = v_party), s.default_credit_days);
    v_doc := jsonb_build_object('kind', 'cxc', 'party_id', v_party, 'party_name', v_name,
      'party_nit', coalesce(v.cliente_nit, v.metadata->>'nit'), 'party_nrc', v.cliente_nrc,
      'doc_type', v_tipo, 'doc_number', v_ref, 'doc_date', v.fecha,
      'due_date', CASE WHEN v_cond = 2 THEN v.fecha + v_days ELSE v.fecha END,
      'amount', v_sign * (v_total - v_rrenta - v_riva), 'description', NULLIF(v.descripcion, ''));
  END IF;

  RETURN jsonb_build_object('date', v.fecha,
    'concept', CASE WHEN v_nc THEN 'Nota de crédito ' ELSE CASE v_tipo WHEN '01' THEN 'Factura ' WHEN '03' THEN 'CCF ' ELSE 'Venta ' END END || v_ref || ' · ' || v_name,
    'ref', v_ref, 'lines', accounting.amount_lines(v_lines), 'doc', v_doc);
END;
$$;

/** [{account_id, amount (+debe / −haber), …}] → líneas debe/haber, sin ceros. */
CREATE OR REPLACE FUNCTION accounting.amount_lines(p JSONB)
RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_agg(
           (l - 'amount' - 'role')
           || jsonb_build_object('debit', CASE WHEN (l->>'amount')::NUMERIC > 0 THEN round((l->>'amount')::NUMERIC, 2) ELSE 0 END,
                                 'credit', CASE WHEN (l->>'amount')::NUMERIC < 0 THEN round(-(l->>'amount')::NUMERIC, 2) ELSE 0 END)
           ORDER BY ord), '[]'::JSONB)
  FROM jsonb_array_elements(p) WITH ORDINALITY AS t(l, ord)
  WHERE round(coalesce((l->>'amount')::NUMERIC, 0), 2) <> 0;
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
  v_base := coalesce(c.gravado, 0) + coalesce(c.exento, 0);
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

-- =============================================================================
-- SINCRONIZACIÓN documento → asiento (+ auxiliar CxC/CxP)
-- =============================================================================
CREATE OR REPLACE FUNCTION accounting.sync_document(p_tenant BIGINT, p_module TEXT, p_id BIGINT)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_plan   JSONB;
  v_fp     TEXT;
  v_prev   accounting.document_postings%ROWTYPE;
  v_doc    accounting.documents%ROWTYPE;
  v_entry  BIGINT;
  v_event  TEXT := CASE p_module WHEN 'ventas' THEN 'SALE_POSTED' ELSE 'PURCHASE_POSTED' END;
  v_applied NUMERIC(14,2);
BEGIN
  v_plan := CASE p_module WHEN 'ventas' THEN accounting.plan_venta(p_tenant, p_id) ELSE accounting.plan_compra(p_tenant, p_id) END;
  v_fp := md5(v_plan::TEXT);
  SELECT * INTO v_prev FROM accounting.document_postings WHERE tenant_id = p_tenant AND module = p_module AND source_id = p_id;
  IF FOUND AND v_prev.status = 'contabilizado' AND v_prev.fingerprint = v_fp THEN RETURN 'sin_cambios'; END IF;

  SELECT * INTO v_doc FROM accounting.documents WHERE tenant_id = p_tenant AND source_module = p_module AND source_id = p_id::TEXT;
  IF FOUND THEN
    SELECT coalesce(sum(a.amount), 0) INTO v_applied FROM accounting.payment_allocations a
      JOIN accounting.payments p ON p.id = a.payment_id WHERE a.document_id = v_doc.id AND p.status = 'vigente';
    IF v_applied <> 0 AND (v_plan ? 'skip' OR (v_plan->'doc'->>'amount')::NUMERIC IS DISTINCT FROM v_doc.amount) THEN
      RAISE EXCEPTION 'El documento % tiene cobros/pagos aplicados por %: anúlalos antes de cambiar su monto o anularlo',
        v_doc.doc_number, v_applied USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Revertir lo contabilizado antes (si cambió)
  PERFORM accounting.reverse_source(p_tenant, p_module, p_id::TEXT, v_event,
    CASE WHEN v_plan->>'skip' = 'deleted' THEN 'Documento eliminado'
         WHEN v_plan->>'skip' = 'anulado' THEN 'Documento anulado'
         ELSE 'Documento modificado' END);

  IF v_plan ? 'skip' THEN
    UPDATE accounting.documents SET status = 'anulado', updated_at = NOW()
     WHERE tenant_id = p_tenant AND source_module = p_module AND source_id = p_id::TEXT;
    IF v_plan->>'skip' = 'deleted' THEN
      DELETE FROM accounting.document_postings WHERE tenant_id = p_tenant AND module = p_module AND source_id = p_id;
    ELSE
      INSERT INTO accounting.document_postings (tenant_id, module, source_id, status, entry_id, fingerprint, message, doc_date, updated_at)
      VALUES (p_tenant, p_module, p_id, 'omitido', NULL, v_fp, v_plan->>'skip', (v_plan->>'date')::DATE, NOW())
      ON CONFLICT (tenant_id, module, source_id) DO UPDATE
        SET status = 'omitido', entry_id = NULL, fingerprint = v_fp, message = EXCLUDED.message, doc_date = EXCLUDED.doc_date, updated_at = NOW();
    END IF;
    RETURN v_plan->>'skip';
  END IF;

  v_entry := accounting.create_entry(p_tenant, (v_plan->>'date')::DATE, v_event, p_module, p_id::TEXT,
                                     v_plan->>'ref', v_plan->>'concept', v_plan->'lines');

  IF v_plan->'doc' IS NOT NULL AND jsonb_typeof(v_plan->'doc') = 'object' THEN
    INSERT INTO accounting.documents (tenant_id, kind, source_module, source_id, party_id, party_name, party_nit, party_nrc,
                                      doc_type, doc_number, doc_date, due_date, amount, description, status, entry_id)
    SELECT p_tenant, x->>'kind', p_module, p_id::TEXT, NULLIF(x->>'party_id', '')::BIGINT, x->>'party_name', x->>'party_nit', x->>'party_nrc',
           x->>'doc_type', x->>'doc_number', (x->>'doc_date')::DATE, (x->>'due_date')::DATE, (x->>'amount')::NUMERIC,
           x->>'description', 'vigente', v_entry
    FROM (SELECT v_plan->'doc' AS x) t
    ON CONFLICT (tenant_id, source_module, source_id) DO UPDATE SET
      kind = EXCLUDED.kind, party_id = EXCLUDED.party_id, party_name = EXCLUDED.party_name, party_nit = EXCLUDED.party_nit,
      party_nrc = EXCLUDED.party_nrc, doc_type = EXCLUDED.doc_type, doc_number = EXCLUDED.doc_number, doc_date = EXCLUDED.doc_date,
      due_date = EXCLUDED.due_date, amount = EXCLUDED.amount, description = EXCLUDED.description, status = 'vigente',
      entry_id = EXCLUDED.entry_id, updated_at = NOW();
  ELSE
    UPDATE accounting.documents SET status = 'anulado', updated_at = NOW()
     WHERE tenant_id = p_tenant AND source_module = p_module AND source_id = p_id::TEXT;
  END IF;

  INSERT INTO accounting.document_postings (tenant_id, module, source_id, status, entry_id, fingerprint, message, doc_date, doc_ref, updated_at)
  VALUES (p_tenant, p_module, p_id, 'contabilizado', v_entry, v_fp, NULL, (v_plan->>'date')::DATE, v_plan->>'ref', NOW())
  ON CONFLICT (tenant_id, module, source_id) DO UPDATE
    SET status = 'contabilizado', entry_id = v_entry, fingerprint = v_fp, message = NULL,
        doc_date = EXCLUDED.doc_date, doc_ref = EXCLUDED.doc_ref, updated_at = NOW();
  RETURN 'contabilizado';
END;
$$;

/** Igual que sync_document pero nunca falla: registra el error para el contador. */
CREATE OR REPLACE FUNCTION accounting.try_sync_document(p_tenant BIGINT, p_module TEXT, p_id BIGINT)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_msg TEXT;
  v_date DATE;
BEGIN
  BEGIN
    RETURN accounting.sync_document(p_tenant, p_module, p_id);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF p_module = 'ventas' THEN SELECT fecha INTO v_date FROM public.ventas WHERE id = p_id;
    ELSE SELECT fecha INTO v_date FROM public.compras WHERE id = p_id; END IF;
    INSERT INTO accounting.document_postings (tenant_id, module, source_id, status, message, doc_date, updated_at)
    VALUES (p_tenant, p_module, p_id, 'error', v_msg, v_date, NOW())
    ON CONFLICT (tenant_id, module, source_id) DO UPDATE
      SET status = 'error', message = v_msg, doc_date = coalesce(EXCLUDED.doc_date, accounting.document_postings.doc_date), updated_at = NOW();
    RETURN 'error';
  END;
END;
$$;

CREATE OR REPLACE FUNCTION accounting.on_document_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_tenant BIGINT := coalesce(NEW.tenant_id, OLD.tenant_id);
  v_id     BIGINT := coalesce(NEW.id, OLD.id);
  v_module TEXT := TG_ARGV[0];
BEGIN
  IF NOT coalesce((SELECT auto_post FROM accounting.settings WHERE tenant_id = v_tenant), false) THEN
    RETURN NULL;
  END IF;
  -- Un borrado de algo nunca contabilizado no hace nada
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM accounting.document_postings
                                      WHERE tenant_id = v_tenant AND module = v_module AND source_id = v_id) THEN
    RETURN NULL;
  END IF;
  PERFORM accounting.try_sync_document(v_tenant, v_module, v_id);
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_ventas_accounting AFTER INSERT OR UPDATE OR DELETE ON public.ventas
  FOR EACH ROW EXECUTE FUNCTION accounting.on_document_change('ventas');
CREATE TRIGGER trg_compras_accounting AFTER INSERT OR UPDATE OR DELETE ON public.compras
  FOR EACH ROW EXECUTE FUNCTION accounting.on_document_change('compras');

-- =============================================================================
-- COBROS Y PAGOS
-- =============================================================================
/**
 * Registra un cobro (cxc) o pago (cxp) y lo aplica a documentos.
 * p_allocations: [{document_id, amount}] — amount puede ser negativo para
 * compensar una nota de crédito. Lo no aplicado queda como anticipo.
 * Asiento: cobro → Debe fondos / Haber clientes (+ anticipos de clientes);
 *          pago  → Debe proveedores (+ anticipos a proveedores) / Haber fondos.
 * Método 'compensacion' (monto 0): solo cruza NC contra facturas.
 */
CREATE OR REPLACE FUNCTION accounting.register_payment(
  p_tenant BIGINT, p_kind TEXT, p_date DATE, p_party_key TEXT, p_method TEXT, p_fund_account BIGINT,
  p_amount NUMERIC, p_allocations JSONB, p_reference TEXT, p_notes TEXT
)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  v_doc_kind TEXT := CASE p_kind WHEN 'cobro' THEN 'cxc' ELSE 'cxp' END;
  v_ctrl     BIGINT := accounting.role_account(p_tenant, CASE p_kind WHEN 'cobro' THEN 'receivables' ELSE 'payables' END);
  v_adv_role TEXT := CASE p_kind WHEN 'cobro' THEN 'customer_advances' ELSE 'supplier_advances' END;
  v_alloc    JSONB;
  v_doc      RECORD;
  v_applied  NUMERIC(14,2) := 0;
  v_unapp    NUMERIC(14,2);
  v_id       BIGINT;
  v_number   BIGINT;
  v_party_id BIGINT;
  v_party_name TEXT;
  v_lines    JSONB := '[]';
  v_sign     INT := CASE p_kind WHEN 'cobro' THEN 1 ELSE -1 END;   -- cobro: fondos al debe
  v_entry    BIGINT;
  v_fund     accounting.accounts%ROWTYPE;
BEGIN
  IF p_kind NOT IN ('cobro', 'pago') THEN RAISE EXCEPTION 'Tipo inválido' USING ERRCODE = '22023'; END IF;
  p_amount := round(coalesce(p_amount, 0), 2);
  IF p_amount < 0 THEN RAISE EXCEPTION 'El monto no puede ser negativo' USING ERRCODE = '22023'; END IF;
  IF p_amount > 0 THEN
    SELECT * INTO v_fund FROM accounting.accounts WHERE id = p_fund_account AND tenant_id = p_tenant;
    IF NOT FOUND THEN RAISE EXCEPTION 'Indica la cuenta de caja o banco' USING ERRCODE = '22023'; END IF;
    IF NOT v_fund.allows_movements THEN RAISE EXCEPTION 'La cuenta % es de mayor', v_fund.code USING ERRCODE = '22023'; END IF;
  ELSIF p_method <> 'compensacion' THEN
    RAISE EXCEPTION 'Indica el monto' USING ERRCODE = '22023';
  END IF;

  -- Validar aplicaciones (mismo tercero, mismo tipo, sin pasarse del saldo)
  FOR v_alloc IN SELECT * FROM jsonb_array_elements(coalesce(p_allocations, '[]')) LOOP
    -- Bloquea el documento (evita que dos cobros simultáneos se pasen del saldo)
    PERFORM 1 FROM accounting.documents WHERE id = (v_alloc->>'document_id')::BIGINT AND tenant_id = p_tenant FOR UPDATE;
    SELECT * INTO v_doc FROM accounting.document_balances
     WHERE id = (v_alloc->>'document_id')::BIGINT AND tenant_id = p_tenant;
    IF NOT FOUND OR v_doc.kind <> v_doc_kind OR v_doc.status <> 'vigente' THEN
      RAISE EXCEPTION 'Documento no válido para este %', p_kind USING ERRCODE = '22023';
    END IF;
    IF v_doc.party_key <> p_party_key THEN
      RAISE EXCEPTION 'El documento % es de otro tercero', v_doc.doc_number USING ERRCODE = '22023';
    END IF;
    IF round((v_alloc->>'amount')::NUMERIC, 2) = 0 THEN CONTINUE; END IF;
    IF sign((v_alloc->>'amount')::NUMERIC) <> sign(v_doc.amount)
       OR abs((v_alloc->>'amount')::NUMERIC) > abs(v_doc.balance) + 0.004 THEN
      RAISE EXCEPTION 'Se aplica % al documento % pero su saldo es %', (v_alloc->>'amount')::NUMERIC, v_doc.doc_number, v_doc.balance
        USING ERRCODE = '22023';
    END IF;
    v_applied := v_applied + round((v_alloc->>'amount')::NUMERIC, 2);
    v_party_id := coalesce(v_party_id, v_doc.party_id);
    v_party_name := coalesce(v_party_name, v_doc.party_name);
  END LOOP;

  v_unapp := p_amount - v_applied;
  IF v_unapp < 0 THEN
    RAISE EXCEPTION 'Lo aplicado (%) supera el monto del %', v_applied, p_kind USING ERRCODE = '22023';
  END IF;
  IF v_party_name IS NULL THEN
    -- Anticipo puro: el tercero viene de la llave
    IF p_party_key LIKE 'id:%' THEN
      v_party_id := substr(p_party_key, 4)::BIGINT;
      SELECT nombre INTO v_party_name FROM public.contribuyentes WHERE id = v_party_id AND tenant_id = p_tenant;
    END IF;
    IF v_party_name IS NULL THEN RAISE EXCEPTION 'Elige el cliente/proveedor (para un anticipo debe estar registrado en Contribuyentes)' USING ERRCODE = '22023'; END IF;
  END IF;

  v_number := accounting.next_number(p_tenant, p_kind);
  INSERT INTO accounting.payments (tenant_id, kind, number, payment_date, party_id, party_name, party_key, method, fund_account_id,
                                   amount, unapplied, reference, notes, created_by, created_by_name)
  VALUES (p_tenant, p_kind, v_number, p_date, v_party_id, v_party_name, p_party_key, p_method,
          CASE WHEN p_amount > 0 THEN p_fund_account END, p_amount, v_unapp, NULLIF(btrim(p_reference), ''), NULLIF(btrim(p_notes), ''),
          accounting.ctx_user(), accounting.ctx_user_name())
  RETURNING id INTO v_id;

  INSERT INTO accounting.payment_allocations (payment_id, document_id, amount)
  SELECT v_id, (a->>'document_id')::BIGINT, round((a->>'amount')::NUMERIC, 2)
  FROM jsonb_array_elements(coalesce(p_allocations, '[]')) a
  WHERE round((a->>'amount')::NUMERIC, 2) <> 0;

  -- Asiento: fondos ↔ control de terceros (una línea por documento, para el auxiliar) ↔ anticipo
  v_lines := jsonb_build_array(jsonb_build_object('account_id', p_fund_account, 'amount', v_sign * p_amount,
                                                  'description', initcap(p_kind) || ' ' || v_party_name, 'reference', p_reference));
  SELECT v_lines || coalesce(jsonb_agg(jsonb_build_object('account_id', v_ctrl, 'amount', -v_sign * a.amount, 'party_id', d.party_id,
                                                          'description', d.party_name || ' · ' || coalesce(d.doc_number, ''))
                                       ORDER BY a.id), '[]')
  INTO v_lines
  FROM accounting.payment_allocations a JOIN accounting.documents d ON d.id = a.document_id WHERE a.payment_id = v_id;
  IF v_unapp > 0 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', accounting.role_account(p_tenant, v_adv_role),
      'amount', -v_sign * v_unapp, 'party_id', v_party_id, 'description', 'Anticipo · ' || v_party_name));
  END IF;

  v_entry := accounting.create_entry(p_tenant, p_date, CASE p_kind WHEN 'cobro' THEN 'PAYMENT_RECEIVED' ELSE 'SUPPLIER_PAYMENT' END,
    CASE p_kind WHEN 'cobro' THEN 'cxc' ELSE 'cxp' END, v_id::TEXT,
    CASE p_kind WHEN 'cobro' THEN 'Cobro C-' ELSE 'Pago P-' END || lpad(v_number::TEXT, 5, '0'),
    initcap(p_kind) || ' ' || CASE p_kind WHEN 'cobro' THEN 'de ' ELSE 'a ' END || v_party_name, accounting.amount_lines(v_lines));
  UPDATE accounting.payments SET entry_id = v_entry WHERE id = v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION accounting.void_payment(p_tenant BIGINT, p_id BIGINT, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  v accounting.payments%ROWTYPE;
BEGIN
  SELECT * INTO v FROM accounting.payments WHERE id = p_id AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Registro no encontrado' USING ERRCODE = 'P0002'; END IF;
  IF v.status = 'anulado' THEN RETURN; END IF;
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'Indica el motivo de la anulación' USING ERRCODE = '22023'; END IF;
  IF v.entry_id IS NOT NULL THEN
    PERFORM accounting.reverse_entry(p_tenant, v.entry_id, p_reason,
      CASE v.kind WHEN 'cobro' THEN 'PAYMENT_RECEIVED_VOIDED' ELSE 'SUPPLIER_PAYMENT_VOIDED' END);
  END IF;
  UPDATE accounting.payments SET status = 'anulado', voided_at = NOW(), voided_by_name = accounting.ctx_user_name(), void_reason = btrim(p_reason)
   WHERE id = p_id;
END;
$$;

/**
 * Documento manual de CxC/CxP: saldos iniciales por cliente/proveedor o
 * facturas sin DTE. Asiento: CxC → Debe clientes / Haber contrapartida;
 * CxP → Debe contrapartida / Haber proveedores.
 */
CREATE OR REPLACE FUNCTION accounting.create_manual_document(
  p_tenant BIGINT, p_kind TEXT, p_party_id BIGINT, p_doc_type TEXT, p_doc_number TEXT, p_date DATE, p_due DATE,
  p_amount NUMERIC, p_counter_account BIGINT, p_description TEXT
)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  v_party public.contribuyentes%ROWTYPE;
  v_id    BIGINT;
  v_ctrl  BIGINT := accounting.role_account(p_tenant, CASE p_kind WHEN 'cxc' THEN 'receivables' ELSE 'payables' END);
  v_sign  INT := CASE p_kind WHEN 'cxc' THEN 1 ELSE -1 END;
  v_entry BIGINT;
  v_src   TEXT;
BEGIN
  SELECT * INTO v_party FROM public.contribuyentes WHERE id = p_party_id AND tenant_id = p_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'Elige un cliente/proveedor de Contribuyentes' USING ERRCODE = '22023'; END IF;
  IF round(coalesce(p_amount, 0), 2) = 0 THEN RAISE EXCEPTION 'Indica el monto' USING ERRCODE = '22023'; END IF;
  v_src := 'M-' || accounting.next_number(p_tenant, 'manual_doc');
  INSERT INTO accounting.documents (tenant_id, kind, source_module, source_id, party_id, party_name, party_nit, party_nrc,
                                    doc_type, doc_number, doc_date, due_date, amount, description)
  VALUES (p_tenant, p_kind, 'manual', v_src, v_party.id, v_party.nombre, coalesce(v_party.nit, v_party.dui), v_party.nrc,
          coalesce(NULLIF(p_doc_type, ''), 'OTRO'), coalesce(NULLIF(btrim(p_doc_number), ''), v_src), p_date, coalesce(p_due, p_date),
          round(p_amount, 2), NULLIF(btrim(p_description), ''))
  RETURNING id INTO v_id;
  v_entry := accounting.create_entry(p_tenant, p_date, 'MANUAL_DOCUMENT', p_kind, v_src,
    coalesce(NULLIF(btrim(p_doc_number), ''), v_src),
    coalesce(NULLIF(btrim(p_description), ''), CASE p_kind WHEN 'cxc' THEN 'Documento por cobrar ' ELSE 'Documento por pagar ' END || v_party.nombre),
    accounting.amount_lines(jsonb_build_array(
      jsonb_build_object('account_id', v_ctrl, 'amount', v_sign * round(p_amount, 2), 'party_id', v_party.id, 'description', v_party.nombre),
      jsonb_build_object('account_id', p_counter_account, 'amount', -v_sign * round(p_amount, 2), 'description', p_description))));
  UPDATE accounting.documents SET entry_id = v_entry WHERE id = v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION accounting.void_manual_document(p_tenant BIGINT, p_id BIGINT, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  v accounting.document_balances%ROWTYPE;
BEGIN
  SELECT * INTO v FROM accounting.document_balances WHERE id = p_id AND tenant_id = p_tenant;
  IF NOT FOUND OR v.source_module <> 'manual' THEN
    RAISE EXCEPTION 'Solo se anulan aquí documentos manuales; los de ventas/compras se anulan desde su origen' USING ERRCODE = '22023';
  END IF;
  IF v.applied <> 0 THEN RAISE EXCEPTION 'El documento tiene cobros/pagos aplicados' USING ERRCODE = '22023'; END IF;
  IF v.entry_id IS NOT NULL THEN PERFORM accounting.reverse_entry(p_tenant, v.entry_id, p_reason, 'MANUAL_DOCUMENT_VOIDED'); END IF;
  UPDATE accounting.documents SET status = 'anulado', updated_at = NOW() WHERE id = p_id;
END;
$$;

/** Conciliación auxiliar vs cuenta de control (CxC / CxP) a una fecha. */
CREATE OR REPLACE FUNCTION accounting.subledger_check(p_tenant BIGINT, p_kind TEXT, p_date DATE)
RETURNS TABLE (ledger NUMERIC, subledger NUMERIC, advances NUMERIC) LANGUAGE sql STABLE AS $$
  SELECT
    (SELECT coalesce(sum(l.debit - l.credit), 0) * CASE p_kind WHEN 'cxc' THEN 1 ELSE -1 END
       FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id = l.entry_id
      WHERE e.tenant_id = p_tenant AND e.status <> 'borrador' AND e.entry_date <= p_date
        AND l.account_id = accounting.role_account_opt(p_tenant, CASE p_kind WHEN 'cxc' THEN 'receivables' ELSE 'payables' END)),
    (SELECT coalesce(sum(d.amount), 0) - coalesce((SELECT sum(a.amount) FROM accounting.payment_allocations a
              JOIN accounting.payments p ON p.id = a.payment_id
              JOIN accounting.documents d2 ON d2.id = a.document_id
             WHERE p.tenant_id = p_tenant AND p.status = 'vigente' AND d2.kind = p_kind AND d2.status = 'vigente'
               AND p.payment_date <= p_date), 0)
       FROM accounting.documents d WHERE d.tenant_id = p_tenant AND d.kind = p_kind AND d.status = 'vigente' AND d.doc_date <= p_date),
    (SELECT coalesce(sum(p.unapplied), 0) FROM accounting.payments p
      WHERE p.tenant_id = p_tenant AND p.kind = CASE p_kind WHEN 'cxc' THEN 'cobro' ELSE 'pago' END
        AND p.status = 'vigente' AND p.payment_date <= p_date);
$$;
