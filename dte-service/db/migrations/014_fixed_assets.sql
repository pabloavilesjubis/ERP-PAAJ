-- =============================================================================
-- 014_fixed_assets — Activos fijos (F6). Portado de ChuchoWash (0051) y
-- ampliado: allá solo nacían de liquidar una importación; aquí se dan de alta
-- a mano (compra nueva o activo existente con su depreciación acumulada),
-- se deprecian y se dan de baja o se venden.
--
--  * Categorías por empresa con la tasa máxima de la Ley de ISR Art. 30
--    (edificaciones 5%, maquinaria 20%, vehículos 25%, otros bienes muebles
--    50%) y sus cuentas: activo, depreciación acumulada, gasto.
--  * Línea recta mensual desde el mes en que entra en uso; la última cuota
--    ajusta el redondeo. Valor residual opcional.
--  * "Contabilizar depreciación hasta el mes X": un asiento por mes.
--  * Baja / venta: Debe depreciación acumulada + cobro de la venta,
--    Haber activo, diferencia a "resultado por venta o baja de activos".
-- =============================================================================

INSERT INTO accounting.role_definitions (role_key, label, group_name, description, sort_order) VALUES
  ('asset_disposal_result', 'Resultado por venta o baja de activos', 'Activos fijos', 'Ganancia o pérdida al dar de baja un activo', 90)
ON CONFLICT (role_key) DO NOTHING;

CREATE TABLE accounting.asset_categories (
  id                      BIGSERIAL PRIMARY KEY,
  tenant_id               BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name                    TEXT NOT NULL CHECK (btrim(name) <> ''),
  tax_class               TEXT NOT NULL CHECK (tax_class IN ('edificaciones', 'maquinaria', 'vehiculos', 'otros_bienes_muebles')),
  annual_rate             NUMERIC(6,4) NOT NULL CHECK (annual_rate > 0 AND annual_rate <= 1),
  asset_account_id        BIGINT REFERENCES accounting.accounts(id),
  depreciation_account_id BIGINT REFERENCES accounting.accounts(id),
  expense_account_id      BIGINT REFERENCES accounting.accounts(id),
  UNIQUE (tenant_id, name)
);

/** Tasa máxima fiscal (Art. 30 LISR) por clase. */
CREATE OR REPLACE FUNCTION accounting.max_tax_rate(p_class TEXT) RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_class WHEN 'edificaciones' THEN 0.05 WHEN 'maquinaria' THEN 0.20 WHEN 'vehiculos' THEN 0.25 ELSE 0.50 END
$$;

CREATE OR REPLACE FUNCTION accounting.ensure_asset_categories(p_tenant BIGINT) RETURNS VOID LANGUAGE sql AS $$
  INSERT INTO accounting.asset_categories (tenant_id, name, tax_class, annual_rate)
  SELECT p_tenant, n, c, accounting.max_tax_rate(c)
  FROM (VALUES ('Edificaciones', 'edificaciones'), ('Maquinaria y equipo', 'maquinaria'), ('Vehículos', 'vehiculos'),
               ('Mobiliario y equipo de oficina', 'otros_bienes_muebles'), ('Equipo de cómputo', 'otros_bienes_muebles')) v(n, c)
  WHERE NOT EXISTS (SELECT 1 FROM accounting.asset_categories WHERE tenant_id = p_tenant)
$$;

CREATE TABLE accounting.fixed_assets (
  id                 BIGSERIAL PRIMARY KEY,
  tenant_id          BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  code               TEXT NOT NULL,
  name               TEXT NOT NULL CHECK (btrim(name) <> ''),
  category_id        BIGINT NOT NULL REFERENCES accounting.asset_categories(id),
  acquisition_date   DATE NOT NULL,
  in_service_date    DATE NOT NULL,
  cost               NUMERIC(14,2) NOT NULL CHECK (cost > 0),
  salvage_value      NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (salvage_value >= 0),
  annual_rate        NUMERIC(6,4) NOT NULL CHECK (annual_rate > 0 AND annual_rate <= 1),
  months             INT NOT NULL CHECK (months > 0),
  opening_accumulated NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (opening_accumulated >= 0),   -- depreciación previa (activo existente)
  opening_date       DATE,                                                                 -- desde cuándo se deprecia en este sistema
  serial_number      TEXT,
  location           TEXT,
  supplier           TEXT,
  invoice_ref        TEXT,
  compra_id          BIGINT REFERENCES public.compras(id) ON DELETE SET NULL,
  import_id          BIGINT REFERENCES accounting.imports(id),
  acquisition_entry_id BIGINT REFERENCES accounting.journal_entries(id),
  status             TEXT NOT NULL DEFAULT 'activo' CHECK (status IN ('activo', 'baja')),
  disposal_date      DATE,
  disposal_kind      TEXT CHECK (disposal_kind IN ('venta', 'baja')),
  disposal_amount    NUMERIC(14,2),
  disposal_entry_id  BIGINT REFERENCES accounting.journal_entries(id),
  notes              TEXT,
  created_by_name    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (salvage_value + opening_accumulated < cost),
  UNIQUE (tenant_id, code)
);

CREATE TABLE accounting.fixed_asset_schedule (
  asset_id    BIGINT NOT NULL REFERENCES accounting.fixed_assets(id) ON DELETE CASCADE,
  period      DATE NOT NULL,                  -- primer día del mes
  amount      NUMERIC(14,2) NOT NULL,
  accumulated NUMERIC(14,2) NOT NULL,
  book_value  NUMERIC(14,2) NOT NULL,
  entry_id    BIGINT REFERENCES accounting.journal_entries(id),
  PRIMARY KEY (asset_id, period)
);

/** Tabla de depreciación línea recta (reemplaza las cuotas aún no contabilizadas). */
CREATE OR REPLACE FUNCTION accounting.build_depreciation_schedule(p_asset BIGINT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  a       accounting.fixed_assets%ROWTYPE;
  v_start DATE;
  v_done  INT;
  v_left  INT;
  v_base  NUMERIC(14,2);
  v_month NUMERIC(14,2);
  v_acc   NUMERIC(14,2);
  v_i     INT;
  v_amt   NUMERIC(14,2);
BEGIN
  SELECT * INTO a FROM accounting.fixed_assets WHERE id = p_asset;
  DELETE FROM accounting.fixed_asset_schedule WHERE asset_id = p_asset AND entry_id IS NULL;
  -- Cuotas ya contabilizadas se conservan; se reparte lo que falta
  SELECT count(*), coalesce(max(accumulated), a.opening_accumulated) INTO v_done, v_acc
    FROM accounting.fixed_asset_schedule WHERE asset_id = p_asset;
  v_start := date_trunc('month', coalesce(a.opening_date, a.in_service_date))::DATE;
  IF v_done > 0 THEN
    SELECT (max(period) + INTERVAL '1 month')::DATE INTO v_start FROM accounting.fixed_asset_schedule WHERE asset_id = p_asset;
  END IF;
  -- Meses restantes: totales − los ya transcurridos antes de entrar al sistema − los contabilizados
  v_left := a.months - v_done
    - CASE WHEN a.opening_date IS NOT NULL
           THEN greatest((extract(year FROM age(date_trunc('month', a.opening_date), date_trunc('month', a.in_service_date))) * 12
                         + extract(month FROM age(date_trunc('month', a.opening_date), date_trunc('month', a.in_service_date))))::INT, 0)
           ELSE 0 END;
  v_base := a.cost - a.salvage_value - v_acc;
  IF v_left <= 0 OR v_base <= 0 OR a.status <> 'activo' THEN RETURN; END IF;
  v_month := round(v_base / v_left, 2);
  FOR v_i IN 1..v_left LOOP
    v_amt := CASE WHEN v_i = v_left THEN a.cost - a.salvage_value - v_acc ELSE least(v_month, a.cost - a.salvage_value - v_acc) END;
    EXIT WHEN v_amt <= 0;
    v_acc := v_acc + v_amt;
    INSERT INTO accounting.fixed_asset_schedule (asset_id, period, amount, accumulated, book_value)
    VALUES (p_asset, (v_start + make_interval(months => v_i - 1))::DATE, v_amt, v_acc, a.cost - v_acc);
  END LOOP;
END;
$$;

/**
 * Alta de un activo. Con p_counter_account registra la adquisición
 * (Debe activo / Haber contrapartida: proveedores, banco, compras por
 * liquidar…); sin ella, el activo ya está en los libros (saldo inicial o
 * compra contabilizada a la cuenta del activo).
 */
CREATE OR REPLACE FUNCTION accounting.create_fixed_asset(p_tenant BIGINT, p JSONB, p_counter_account BIGINT)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  c       accounting.asset_categories%ROWTYPE;
  v_rate  NUMERIC(6,4);
  v_id    BIGINT;
  v_code  TEXT;
  v_entry BIGINT;
BEGIN
  SELECT * INTO c FROM accounting.asset_categories WHERE id = (p->>'category_id')::BIGINT AND tenant_id = p_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'Elige la categoría' USING ERRCODE = '22023'; END IF;
  IF c.asset_account_id IS NULL OR c.depreciation_account_id IS NULL OR c.expense_account_id IS NULL THEN
    RAISE EXCEPTION 'Configura las cuentas de la categoría «%» (activo, depreciación acumulada y gasto)', c.name USING ERRCODE = '22023';
  END IF;
  v_rate := coalesce(NULLIF(p->>'annual_rate', '')::NUMERIC, c.annual_rate);
  IF v_rate > accounting.max_tax_rate(c.tax_class) THEN
    RAISE EXCEPTION 'La tasa % supera la máxima fiscal del Art. 30 LISR para % (%)', v_rate, c.tax_class, accounting.max_tax_rate(c.tax_class)
      USING ERRCODE = '22023';
  END IF;
  v_code := coalesce(NULLIF(btrim(p->>'code'), ''), 'AF-' || lpad(accounting.next_number(p_tenant, 'asset')::TEXT, 5, '0'));
  INSERT INTO accounting.fixed_assets (tenant_id, code, name, category_id, acquisition_date, in_service_date, cost, salvage_value,
    annual_rate, months, opening_accumulated, opening_date, serial_number, location, supplier, invoice_ref, compra_id, notes, created_by_name)
  VALUES (p_tenant, v_code, btrim(p->>'name'), c.id, (p->>'acquisition_date')::DATE,
    coalesce(NULLIF(p->>'in_service_date', '')::DATE, (p->>'acquisition_date')::DATE),
    round((p->>'cost')::NUMERIC, 2), round(coalesce(NULLIF(p->>'salvage_value', '')::NUMERIC, 0), 2), v_rate, ceil(12 / v_rate)::INT,
    round(coalesce(NULLIF(p->>'opening_accumulated', '')::NUMERIC, 0), 2), NULLIF(p->>'opening_date', '')::DATE,
    NULLIF(p->>'serial_number', ''), NULLIF(p->>'location', ''), NULLIF(p->>'supplier', ''), NULLIF(p->>'invoice_ref', ''),
    NULLIF(p->>'compra_id', '')::BIGINT, NULLIF(p->>'notes', ''), accounting.ctx_user_name())
  RETURNING id INTO v_id;

  IF p_counter_account IS NOT NULL THEN
    v_entry := accounting.create_entry(p_tenant, (p->>'acquisition_date')::DATE, 'ASSET_ACQUIRED', 'activos', v_id::TEXT, v_code,
      'Adquisición de ' || btrim(p->>'name'),
      accounting.amount_lines(jsonb_build_array(
        jsonb_build_object('account_id', c.asset_account_id, 'amount', round((p->>'cost')::NUMERIC, 2), 'description', btrim(p->>'name')),
        jsonb_build_object('account_id', p_counter_account, 'amount', -round((p->>'cost')::NUMERIC, 2), 'description', btrim(p->>'name')))));
    UPDATE accounting.fixed_assets SET acquisition_entry_id = v_entry WHERE id = v_id;
  END IF;
  PERFORM accounting.build_depreciation_schedule(v_id);
  RETURN v_id;
END;
$$;

/** Contabiliza las cuotas pendientes hasta p_through: un asiento por mes (gasto vs acumulada por categoría). */
CREATE OR REPLACE FUNCTION accounting.post_depreciation(p_tenant BIGINT, p_through DATE) RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
  v_period DATE;
  v_lines  JSONB;
  v_entry  BIGINT;
  v_n      INT := 0;
BEGIN
  FOR v_period IN
    SELECT DISTINCT s.period FROM accounting.fixed_asset_schedule s JOIN accounting.fixed_assets a ON a.id = s.asset_id
     WHERE a.tenant_id = p_tenant AND a.status = 'activo' AND s.entry_id IS NULL AND s.period <= date_trunc('month', p_through)
     ORDER BY 1
  LOOP
    SELECT jsonb_agg(l) INTO v_lines FROM (
      SELECT jsonb_build_object('account_id', c.expense_account_id, 'amount', sum(s.amount), 'description', 'Depreciación ' || c.name) AS l
        FROM accounting.fixed_asset_schedule s JOIN accounting.fixed_assets a ON a.id = s.asset_id JOIN accounting.asset_categories c ON c.id = a.category_id
       WHERE a.tenant_id = p_tenant AND a.status = 'activo' AND s.entry_id IS NULL AND s.period = v_period GROUP BY c.id, c.name, c.expense_account_id
      UNION ALL
      SELECT jsonb_build_object('account_id', c.depreciation_account_id, 'amount', -sum(s.amount), 'description', 'Depreciación acumulada ' || c.name)
        FROM accounting.fixed_asset_schedule s JOIN accounting.fixed_assets a ON a.id = s.asset_id JOIN accounting.asset_categories c ON c.id = a.category_id
       WHERE a.tenant_id = p_tenant AND a.status = 'activo' AND s.entry_id IS NULL AND s.period = v_period GROUP BY c.id, c.name, c.depreciation_account_id
    ) x;
    v_entry := accounting.create_entry(p_tenant, (v_period + INTERVAL '1 month - 1 day')::DATE, 'DEPRECIATION', 'activos',
      'DEP-' || to_char(v_period, 'YYYY-MM'), 'Depreciación ' || to_char(v_period, 'MM/YYYY'),
      'Depreciación de activos fijos de ' || to_char(v_period, 'MM/YYYY'), accounting.amount_lines(v_lines));
    UPDATE accounting.fixed_asset_schedule s SET entry_id = v_entry
      FROM accounting.fixed_assets a
     WHERE a.id = s.asset_id AND a.tenant_id = p_tenant AND a.status = 'activo' AND s.entry_id IS NULL AND s.period = v_period;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$$;

/** Baja o venta: la depreciación debe estar contabilizada hasta el mes anterior. */
CREATE OR REPLACE FUNCTION accounting.dispose_fixed_asset(
  p_tenant BIGINT, p_asset BIGINT, p_kind TEXT, p_date DATE, p_amount NUMERIC, p_proceeds_account BIGINT, p_notes TEXT
) RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  a      accounting.fixed_assets%ROWTYPE;
  c      accounting.asset_categories%ROWTYPE;
  v_acc  NUMERIC(14,2);
  v_amt  NUMERIC(14,2) := round(coalesce(p_amount, 0), 2);
  v_res  NUMERIC(14,2);
  v_entry BIGINT;
BEGIN
  SELECT * INTO a FROM accounting.fixed_assets WHERE id = p_asset AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND OR a.status <> 'activo' THEN RAISE EXCEPTION 'Activo no encontrado o ya dado de baja' USING ERRCODE = '22023'; END IF;
  IF p_kind NOT IN ('venta', 'baja') THEN RAISE EXCEPTION 'Tipo inválido' USING ERRCODE = '22023'; END IF;
  IF p_kind = 'venta' AND (v_amt <= 0 OR p_proceeds_account IS NULL) THEN RAISE EXCEPTION 'Indica el precio de venta y dónde se cobra' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM accounting.fixed_asset_schedule WHERE asset_id = a.id AND entry_id IS NULL AND period < date_trunc('month', p_date)) THEN
    RAISE EXCEPTION 'Contabiliza primero la depreciación hasta el mes anterior a la baja' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO c FROM accounting.asset_categories WHERE id = a.category_id;
  SELECT coalesce(max(accumulated), a.opening_accumulated) INTO v_acc FROM accounting.fixed_asset_schedule WHERE asset_id = a.id AND entry_id IS NOT NULL;
  v_res := v_amt - (a.cost - v_acc);   -- + ganancia / − pérdida
  v_entry := accounting.create_entry(p_tenant, p_date, 'ASSET_DISPOSED', 'activos', a.id::TEXT, a.code,
    CASE p_kind WHEN 'venta' THEN 'Venta de ' ELSE 'Baja de ' END || a.name,
    accounting.amount_lines(jsonb_build_array(
      jsonb_build_object('account_id', CASE WHEN v_acc > 0 THEN c.depreciation_account_id END, 'amount', v_acc, 'description', 'Depreciación acumulada'),
      jsonb_build_object('account_id', p_proceeds_account, 'amount', v_amt, 'description', 'Precio de venta'),
      jsonb_build_object('account_id', CASE WHEN v_res <> 0 THEN accounting.role_account(p_tenant, 'asset_disposal_result') END,
                         'amount', -v_res, 'description', CASE WHEN v_res >= 0 THEN 'Ganancia' ELSE 'Pérdida' END || ' en ' || p_kind),
      jsonb_build_object('account_id', c.asset_account_id, 'amount', -a.cost, 'description', a.name))));
  DELETE FROM accounting.fixed_asset_schedule WHERE asset_id = a.id AND entry_id IS NULL;
  UPDATE accounting.fixed_assets SET status = 'baja', disposal_date = p_date, disposal_kind = p_kind, disposal_amount = v_amt,
         disposal_entry_id = v_entry, notes = coalesce(NULLIF(btrim(p_notes), ''), notes)
   WHERE id = a.id;
  RETURN v_entry;
END;
$$;
