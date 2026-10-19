-- =============================================================================
-- 006_accounting_core — Núcleo contable (F1). Portado de ChuchoWash
-- (0023/0032) y generalizado para cualquier empresa del SaaS.
--
-- Principios:
--  * Partida doble garantizada por la base: un asiento CONTABILIZADO cumple
--    debe = haber > 0, verificado por un constraint trigger DEFERRED (al
--    COMMIT). Montos NUMERIC(14,2).
--  * Un solo motor: accounting.create_entry / reverse_entry. Los módulos
--    (ventas, compras, bancos, planilla…) llaman a builders dentro de su misma
--    transacción.
--  * Idempotente: UNIQUE (tenant, source_module, source_id, event_type).
--  * Sin códigos de cuenta en la lógica: las cuentas se resuelven por "roles"
--    que cada empresa asigna a su propio catálogo (account_roles).
--  * Asientos contabilizados inmutables: se corrigen anulando (reversión
--    enlazada) o con una partida de ajuste. Nunca se borran.
--  * Cuentas de mayor (agrupadoras) nunca reciben movimientos.
--  * Períodos mensuales: en un mes cerrado no se registra nada (nuevo; en
--    ChuchoWash no existía).
--
-- Multi-empresa: no hay RLS ni sesión en la base. Cada función recibe
-- p_tenant explícito; el backend lo saca del JWT. El usuario que registra se
-- toma de los settings de la transacción (app.user_id / app.user_name), que
-- el backend fija con SET LOCAL (ver src/erp/http.ts → tx()).
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS accounting;

-- ── Contexto de usuario de la transacción ──
CREATE OR REPLACE FUNCTION accounting.ctx_user() RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '');
$$;
CREATE OR REPLACE FUNCTION accounting.ctx_user_name() RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT coalesce(NULLIF(current_setting('app.user_name', true), ''), 'Sistema');
$$;

/** Fecha de negocio (El Salvador), para reversiones y defaults. */
CREATE OR REPLACE FUNCTION accounting.today() RETURNS DATE LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE 'America/El_Salvador')::DATE;
$$;

-- ── Correlativos internos (asientos, pagos, cobros…) ──
CREATE TABLE accounting.counters (
  tenant_id  BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  last_value BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, key)
);

CREATE OR REPLACE FUNCTION accounting.next_number(p_tenant BIGINT, p_key TEXT)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  v BIGINT;
BEGIN
  INSERT INTO accounting.counters (tenant_id, key, last_value) VALUES (p_tenant, p_key, 1)
  ON CONFLICT (tenant_id, key) DO UPDATE SET last_value = accounting.counters.last_value + 1
  RETURNING last_value INTO v;
  RETURN v;
END;
$$;

-- =============================================================================
-- CATÁLOGO DE CUENTAS (cada empresa carga el suyo)
-- =============================================================================
CREATE TABLE accounting.accounts (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  code                TEXT NOT NULL,
  name                TEXT NOT NULL,
  account_type        TEXT NOT NULL CHECK (account_type IN ('Activo', 'Contraactivo', 'Pasivo', 'Patrimonio', 'Ingreso', 'Costo', 'Gasto', 'Resultado')),
  nature              TEXT NOT NULL CHECK (nature IN ('Deudora', 'Acreedora', 'Mixta')),
  parent_id           BIGINT REFERENCES accounting.accounts(id),
  level               INT NOT NULL DEFAULT 1,
  financial_statement TEXT NOT NULL CHECK (financial_statement IN ('Balance', 'ER')),
  affects_result      BOOLEAN NOT NULL DEFAULT false,
  result_section      TEXT,
  -- NIIF PYMES 4.4: corriente / no_corriente; NULL = hereda del grupo más cercano
  balance_term        TEXT CHECK (balance_term IN ('corriente', 'no_corriente')),
  allows_movements    BOOLEAN NOT NULL DEFAULT true,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT accounts_code_format CHECK (code ~ '^[0-9]+([.-][0-9]+)*$'),
  CONSTRAINT accounts_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT accounts_result_consistency CHECK (affects_result = (financial_statement = 'ER')),
  UNIQUE (tenant_id, code)
);
CREATE INDEX idx_accounts_parent ON accounting.accounts(parent_id);
CREATE INDEX idx_accounts_tenant ON accounting.accounts(tenant_id, code);

COMMENT ON TABLE accounting.accounts IS
  'Catálogo de cuentas por empresa. Las cuentas de mayor no reciben movimientos; una cuenta con movimientos se desactiva, nunca se borra.';

/**
 * Reglas del catálogo:
 *  - el código del hijo empieza con el del padre (con o sin separador:
 *    "1.01.02" bajo "1.01", o "110102" bajo "1101");
 *  - el padre debe ser de mayor;
 *  - nivel = nivel del padre + 1;
 *  - no se cambia el código ni se convierte en mayor una cuenta con movimientos.
 */
CREATE OR REPLACE FUNCTION accounting.prepare_account()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_parent accounting.accounts%ROWTYPE;
BEGIN
  NEW.code := btrim(NEW.code);
  NEW.name := btrim(NEW.name);
  NEW.result_section := NULLIF(btrim(NEW.result_section), '');

  IF NEW.parent_id IS NOT NULL THEN
    SELECT * INTO v_parent FROM accounting.accounts WHERE id = NEW.parent_id AND tenant_id = NEW.tenant_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Cuenta padre no encontrada' USING ERRCODE = '22023'; END IF;
    IF v_parent.id = NEW.id THEN RAISE EXCEPTION 'Una cuenta no puede ser su propio padre' USING ERRCODE = '22023'; END IF;
    IF v_parent.allows_movements THEN
      RAISE EXCEPTION 'La cuenta padre % permite movimientos; conviértela en cuenta de mayor antes de agregarle subcuentas', v_parent.code
        USING ERRCODE = '22023';
    END IF;
    IF NEW.code = v_parent.code OR left(NEW.code, length(v_parent.code)) <> v_parent.code THEN
      RAISE EXCEPTION 'El código % no pertenece a la cuenta padre %', NEW.code, v_parent.code USING ERRCODE = '22023';
    END IF;
    NEW.level := v_parent.level + 1;
  ELSE
    NEW.level := 1;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.code IS DISTINCT FROM OLD.code AND EXISTS (SELECT 1 FROM accounting.journal_lines WHERE account_id = OLD.id) THEN
      RAISE EXCEPTION 'La cuenta % ya tiene movimientos: su código no se puede cambiar', OLD.code USING ERRCODE = '22023';
    END IF;
    IF NEW.allows_movements AND NOT OLD.allows_movements
       AND EXISTS (SELECT 1 FROM accounting.accounts WHERE parent_id = OLD.id) THEN
      RAISE EXCEPTION 'La cuenta % tiene subcuentas: no puede recibir movimientos', OLD.code USING ERRCODE = '22023';
    END IF;
    IF NOT NEW.allows_movements AND OLD.allows_movements
       AND EXISTS (SELECT 1 FROM accounting.journal_lines WHERE account_id = OLD.id) THEN
      RAISE EXCEPTION 'La cuenta % ya tiene movimientos: desactívala en lugar de convertirla en cuenta de mayor', OLD.code USING ERRCODE = '22023';
    END IF;
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;
CREATE TRIGGER prepare_accounts BEFORE INSERT OR UPDATE ON accounting.accounts
  FOR EACH ROW EXECUTE FUNCTION accounting.prepare_account();

-- =============================================================================
-- REGLAS DE CONTABILIZACIÓN: roles → cuenta de cada empresa
-- =============================================================================
CREATE TABLE accounting.role_definitions (
  role_key    TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  group_name  TEXT NOT NULL,
  description TEXT,
  sort_order  INT NOT NULL DEFAULT 0
);

CREATE TABLE accounting.account_roles (
  tenant_id  BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  role_key   TEXT NOT NULL REFERENCES accounting.role_definitions(role_key),
  account_id BIGINT NOT NULL REFERENCES accounting.accounts(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, role_key)
);

INSERT INTO accounting.role_definitions (role_key, label, group_name, description, sort_order) VALUES
  ('cash',                 'Caja general',                         'Efectivo y bancos', 'Cobros y pagos en efectivo', 10),
  ('petty_cash',           'Caja chica',                           'Efectivo y bancos', 'Pagos menores', 11),
  ('bank',                 'Banco predeterminado',                 'Efectivo y bancos', 'Cobros y pagos cuando no se indica la cuenta bancaria', 12),
  ('receivables',          'Clientes (CxC)',                       'Terceros',          'Cuenta de control de cuentas por cobrar', 20),
  ('payables',             'Proveedores (CxP)',                    'Terceros',          'Cuenta de control de cuentas por pagar', 21),
  ('customer_advances',    'Anticipos de clientes',                'Terceros',          'Cobros recibidos sin documento aplicado', 22),
  ('supplier_advances',    'Anticipos a proveedores',              'Terceros',          'Pagos hechos sin documento aplicado', 23),
  ('vat_debit',            'IVA débito fiscal',                    'Impuestos',         'IVA de las ventas', 30),
  ('vat_credit',           'IVA crédito fiscal',                   'Impuestos',         'IVA de las compras', 31),
  ('vat_perceived',        'IVA percibido por acreditar',          'Impuestos',         'Percepción 1% que nos cobró un gran contribuyente', 32),
  ('vat_withheld',         'IVA retenido por pagar',               'Impuestos',         'Retención 1% que hicimos a proveedores', 33),
  ('vat_withheld_by_customers', 'IVA retenido por clientes',       'Impuestos',         'Retención 1%/2% que nos hicieron (se acredita en el F-07)', 34),
  ('income_tax_withheld',  'Renta retenida por pagar',             'Impuestos',         'ISR retenido a proveedores y empleados (F-14)', 35),
  ('income_tax_withheld_by_customers', 'Renta retenida por clientes', 'Impuestos',      'ISR que nos retuvieron (anticipo de renta)', 36),
  ('vat_payable',          'IVA por pagar',                        'Impuestos',         'Liquidación mensual del IVA', 37),
  ('payment_on_account',   'Pago a cuenta (anticipo ISR)',         'Impuestos',         'Pago a cuenta mensual del F-14', 38),
  ('income_sales',         'Ventas gravadas',                      'Ingresos',          'Ingreso de ventas gravadas (FCF/CCF)', 50),
  ('income_exempt',        'Ventas exentas / no sujetas',          'Ingresos',          NULL, 51),
  ('sales_returns',        'Devoluciones y rebajas sobre ventas',  'Ingresos',          'Notas de crédito emitidas', 52),
  ('cost_default',         'Costo predeterminado de compras',      'Costos y gastos',   'Compras clasificadas como costo', 60),
  ('expense_default',      'Gasto predeterminado de compras',      'Costos y gastos',   'Compras clasificadas como gasto', 61),
  ('bank_charges',         'Gastos bancarios',                     'Costos y gastos',   'Comisiones y cargos del banco', 62),
  ('current_year_result',  'Utilidad (pérdida) del ejercicio',     'Patrimonio',        'Destino del cierre anual', 80),
  ('retained_earnings',    'Utilidades acumuladas',                'Patrimonio',        'Traslado del resultado de ejercicios anteriores', 81);

/** Cuenta asignada a un rol, o error claro de configuración. */
CREATE OR REPLACE FUNCTION accounting.role_account(p_tenant BIGINT, p_role TEXT)
RETURNS BIGINT LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_id BIGINT;
BEGIN
  SELECT account_id INTO v_id FROM accounting.account_roles WHERE tenant_id = p_tenant AND role_key = p_role;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Falta asignar la cuenta «%» en Contabilidad → Configuración',
      coalesce((SELECT label FROM accounting.role_definitions WHERE role_key = p_role), p_role) USING ERRCODE = '22023';
  END IF;
  RETURN v_id;
END;
$$;

/** Igual que role_account pero NULL si no está configurado (roles opcionales). */
CREATE OR REPLACE FUNCTION accounting.role_account_opt(p_tenant BIGINT, p_role TEXT)
RETURNS BIGINT LANGUAGE sql STABLE AS $$
  SELECT account_id FROM accounting.account_roles WHERE tenant_id = p_tenant AND role_key = p_role;
$$;

-- =============================================================================
-- PERÍODOS (nuevo): mes cerrado = no se registra nada con esa fecha
-- =============================================================================
CREATE TABLE accounting.periods (
  tenant_id  BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  year       INT NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  month      INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  status     TEXT NOT NULL DEFAULT 'abierto' CHECK (status IN ('abierto', 'cerrado')),
  closed_at  TIMESTAMPTZ,
  closed_by  TEXT,
  reopened_at TIMESTAMPTZ,
  reopened_by TEXT,
  notes      TEXT,
  PRIMARY KEY (tenant_id, year, month)
);

CREATE OR REPLACE FUNCTION accounting.period_is_open(p_tenant BIGINT, p_date DATE)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM accounting.periods
    WHERE tenant_id = p_tenant AND year = extract(year FROM p_date)::INT
      AND month = extract(month FROM p_date)::INT AND status = 'cerrado');
$$;

CREATE OR REPLACE FUNCTION accounting.assert_period_open(p_tenant BIGINT, p_date DATE)
RETURNS VOID LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF p_date IS NULL THEN RAISE EXCEPTION 'Indica la fecha contable' USING ERRCODE = '22023'; END IF;
  IF NOT accounting.period_is_open(p_tenant, p_date) THEN
    RAISE EXCEPTION 'El período %/% está cerrado: no se pueden registrar movimientos con fecha %',
      lpad(extract(month FROM p_date)::TEXT, 2, '0'), extract(year FROM p_date), to_char(p_date, 'DD/MM/YYYY')
      USING ERRCODE = '22023';
  END IF;
END;
$$;

-- =============================================================================
-- DIARIO: asientos y líneas
-- =============================================================================
CREATE TABLE accounting.journal_entries (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  entry_number     BIGINT,                                   -- se asigna al contabilizar
  entry_date       DATE NOT NULL,
  entry_type       TEXT NOT NULL CHECK (entry_type IN ('automatico', 'manual', 'reversion')),
  manual_kind      TEXT CHECK (manual_kind IN ('ajuste', 'reclasificacion', 'depreciacion', 'provision', 'correccion', 'cierre', 'apertura', 'otro')),
  concept          TEXT NOT NULL,
  source_module    TEXT,                                     -- ventas, compras, cxc, cxp, bancos, planilla, activos, manual…
  source_id        TEXT,
  source_ref       TEXT,                                     -- referencia legible: "CCF DTE-03-…", "Pago P-000012"
  event_type       TEXT,                                     -- SALE_POSTED, PURCHASE_POSTED, …
  status           TEXT NOT NULL DEFAULT 'borrador' CHECK (status IN ('borrador', 'contabilizado', 'revisado', 'anulado')),
  total_debit      NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_credit     NUMERIC(14,2) NOT NULL DEFAULT 0,
  notes            TEXT,
  reversal_of      BIGINT REFERENCES accounting.journal_entries(id),
  reversed_by      BIGINT REFERENCES accounting.journal_entries(id),
  created_by       TEXT,
  created_by_name  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  posted_at        TIMESTAMPTZ,
  posted_by        TEXT,
  reviewed_at      TIMESTAMPTZ,
  reviewed_by      TEXT,
  reviewed_by_name TEXT,
  review_notes     TEXT,
  voided_at        TIMESTAMPTZ,
  voided_by        TEXT,
  voided_by_name   TEXT,
  void_reason      TEXT,
  CONSTRAINT journal_entries_number_when_posted CHECK (status = 'borrador' OR entry_number IS NOT NULL),
  CONSTRAINT journal_entries_manual_kind CHECK ((entry_type = 'manual') = (manual_kind IS NOT NULL)),
  CONSTRAINT journal_entries_void_reason CHECK (status <> 'anulado' OR void_reason IS NOT NULL),
  UNIQUE (tenant_id, entry_number)
);

-- Idempotencia: un solo asiento VIGENTE por documento y evento. Al anularse
-- (reversión) sale del índice y el documento puede volver a contabilizarse
-- (p.ej. tras editar una compra). Las reversiones se controlan por reversed_by.
CREATE UNIQUE INDEX journal_entries_source_event_unique
  ON accounting.journal_entries(tenant_id, source_module, source_id, event_type)
  WHERE source_id IS NOT NULL AND entry_type <> 'reversion' AND status <> 'anulado';
CREATE INDEX idx_journal_entries_tenant_date ON accounting.journal_entries(tenant_id, entry_date DESC, entry_number DESC);
CREATE INDEX idx_journal_entries_source ON accounting.journal_entries(tenant_id, source_module, source_id);

CREATE TABLE accounting.journal_lines (
  id             BIGSERIAL PRIMARY KEY,
  entry_id       BIGINT NOT NULL REFERENCES accounting.journal_entries(id) ON DELETE CASCADE,
  tenant_id      BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  line_no        INT NOT NULL,
  account_id     BIGINT NOT NULL REFERENCES accounting.accounts(id),
  description    TEXT,
  debit          NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit         NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  party_id       BIGINT REFERENCES public.contribuyentes(id),   -- cliente / proveedor (auxiliares CxC/CxP)
  cost_center    TEXT,
  reference      TEXT,
  source_line_id TEXT,
  CONSTRAINT journal_lines_one_side CHECK ((debit = 0) <> (credit = 0))
);
CREATE INDEX idx_journal_lines_entry ON accounting.journal_lines(entry_id, line_no);
CREATE INDEX idx_journal_lines_account ON accounting.journal_lines(account_id);
CREATE INDEX idx_journal_lines_party ON accounting.journal_lines(party_id) WHERE party_id IS NOT NULL;
CREATE INDEX idx_journal_lines_tenant ON accounting.journal_lines(tenant_id);

COMMENT ON TABLE accounting.journal_entries IS
  'Asientos. Solo los escriben las funciones de accounting; los contabilizados son inmutables y nunca se borran.';

-- ── Cuadre: verificado al COMMIT para cada asiento contabilizado ──
CREATE OR REPLACE FUNCTION accounting.assert_entry_balanced(p_entry_id BIGINT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  v_entry accounting.journal_entries%ROWTYPE;
  v_debit NUMERIC(14,2);
  v_credit NUMERIC(14,2);
  v_bad TEXT;
BEGIN
  SELECT * INTO v_entry FROM accounting.journal_entries WHERE id = p_entry_id;
  IF NOT FOUND OR v_entry.status = 'borrador' THEN RETURN; END IF;
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0) INTO v_debit, v_credit
  FROM accounting.journal_lines WHERE entry_id = p_entry_id;
  IF v_debit <> v_credit OR v_debit = 0 THEN
    RAISE EXCEPTION 'Asiento descuadrado: debe % ≠ haber %', v_debit, v_credit USING ERRCODE = '23514';
  END IF;
  IF v_debit <> v_entry.total_debit OR v_credit <> v_entry.total_credit THEN
    RAISE EXCEPTION 'Los totales del asiento no coinciden con sus líneas' USING ERRCODE = '23514';
  END IF;
  SELECT a.code INTO v_bad FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id = l.account_id
  WHERE l.entry_id = p_entry_id AND (NOT a.allows_movements OR a.tenant_id <> v_entry.tenant_id) LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'La cuenta % es de mayor (agrupadora) o de otra empresa y no acepta movimientos', v_bad USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION accounting.check_lines_balance()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM accounting.assert_entry_balanced(coalesce(NEW.entry_id, OLD.entry_id));
  RETURN NULL;
END;
$$;
CREATE OR REPLACE FUNCTION accounting.check_entry_balance()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM accounting.assert_entry_balanced(NEW.id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT OR UPDATE OR DELETE ON accounting.journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION accounting.check_lines_balance();
CREATE CONSTRAINT TRIGGER journal_entries_balanced AFTER INSERT OR UPDATE ON accounting.journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION accounting.check_entry_balance();

-- ── Inmutabilidad de lo contabilizado ──
CREATE OR REPLACE FUNCTION accounting.guard_journal_lines()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_status TEXT;
BEGIN
  SELECT status INTO v_status FROM accounting.journal_entries WHERE id = coalesce(OLD.entry_id, NEW.entry_id);
  IF v_status IS NOT NULL AND v_status <> 'borrador' THEN
    RAISE EXCEPTION 'Un asiento contabilizado no se puede modificar; anúlalo o registra una partida de ajuste' USING ERRCODE = '42501';
  END IF;
  RETURN coalesce(NEW, OLD);
END;
$$;
CREATE TRIGGER guard_journal_lines BEFORE UPDATE OR DELETE ON accounting.journal_lines
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_journal_lines();

CREATE OR REPLACE FUNCTION accounting.guard_journal_entries()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  -- Campos que pueden cambiar después de contabilizar (revisión, anulación)
  v_mutable TEXT[] := ARRAY['status', 'updated_at', 'reviewed_at', 'reviewed_by', 'reviewed_by_name', 'review_notes',
                            'voided_at', 'voided_by', 'voided_by_name', 'void_reason', 'reversed_by'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'borrador' THEN
      RAISE EXCEPTION 'Un asiento contabilizado no se puede eliminar; anúlalo' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  NEW.updated_at := NOW();
  IF OLD.status = 'borrador' THEN RETURN NEW; END IF;
  IF (to_jsonb(NEW) - v_mutable) <> (to_jsonb(OLD) - v_mutable) THEN
    RAISE EXCEPTION 'Un asiento contabilizado no se puede modificar' USING ERRCODE = '42501';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'contabilizado' AND NEW.status IN ('revisado', 'anulado'))
    OR (OLD.status = 'revisado' AND NEW.status = 'anulado')) THEN
    RAISE EXCEPTION 'Cambio de estado no permitido (% → %)', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_journal_entries BEFORE UPDATE OR DELETE ON accounting.journal_entries
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_journal_entries();

-- =============================================================================
-- MOTOR
-- =============================================================================
/** Inserta las líneas de un asiento validando cuentas; devuelve cuántas insertó. */
CREATE OR REPLACE FUNCTION accounting.insert_lines(p_tenant BIGINT, p_entry_id BIGINT, p_lines JSONB, p_strict_active BOOLEAN)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
  v_line  JSONB;
  v_i     INT := 0;
  v_acc   accounting.accounts%ROWTYPE;
  v_d     NUMERIC(14,2);
  v_c     NUMERIC(14,2);
BEGIN
  FOR v_line IN SELECT * FROM jsonb_array_elements(coalesce(p_lines, '[]')) LOOP
    v_d := round(coalesce(NULLIF(v_line->>'debit', '')::NUMERIC, 0), 2);
    v_c := round(coalesce(NULLIF(v_line->>'credit', '')::NUMERIC, 0), 2);
    CONTINUE WHEN v_d = 0 AND v_c = 0;
    IF v_d < 0 OR v_c < 0 THEN
      RAISE EXCEPTION 'La línea % tiene un monto negativo', v_i + 1 USING ERRCODE = '22023';
    END IF;
    IF v_d > 0 AND v_c > 0 THEN
      RAISE EXCEPTION 'La línea % tiene debe y haber a la vez', v_i + 1 USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_acc FROM accounting.accounts WHERE id = NULLIF(v_line->>'account_id', '')::BIGINT AND tenant_id = p_tenant;
    IF NOT FOUND THEN RAISE EXCEPTION 'Cuenta no encontrada en la línea %', v_i + 1 USING ERRCODE = '22023'; END IF;
    IF NOT v_acc.allows_movements THEN
      RAISE EXCEPTION 'La cuenta % % es de mayor y no acepta movimientos', v_acc.code, v_acc.name USING ERRCODE = '22023';
    END IF;
    IF p_strict_active AND NOT v_acc.is_active THEN
      RAISE EXCEPTION 'La cuenta % % está inactiva', v_acc.code, v_acc.name USING ERRCODE = '22023';
    END IF;
    v_i := v_i + 1;
    INSERT INTO accounting.journal_lines (entry_id, tenant_id, line_no, account_id, description, debit, credit,
                                          party_id, cost_center, reference, source_line_id)
    VALUES (p_entry_id, p_tenant, v_i, v_acc.id, NULLIF(btrim(v_line->>'description'), ''), v_d, v_c,
            NULLIF(v_line->>'party_id', '')::BIGINT, NULLIF(btrim(v_line->>'cost_center'), ''),
            NULLIF(btrim(v_line->>'reference'), ''), NULLIF(v_line->>'source_line_id', ''));
  END LOOP;
  RETURN v_i;
END;
$$;

/**
 * Crea y contabiliza un asiento. El corazón del motor:
 *  - idempotente por (tenant, módulo, origen, evento): un reintento devuelve el existente;
 *  - líneas: [{account_id, debit, credit, description, party_id, cost_center, reference, source_line_id}];
 *    las líneas en cero se descartan;
 *  - rechaza asientos descuadrados y fechas de períodos cerrados;
 *  - devuelve NULL si no hay nada que contabilizar (todo en cero).
 */
CREATE OR REPLACE FUNCTION accounting.create_entry(
  p_tenant      BIGINT,
  p_date        DATE,
  p_event       TEXT,
  p_module      TEXT,
  p_source_id   TEXT,
  p_source_ref  TEXT,
  p_concept     TEXT,
  p_lines       JSONB,
  p_entry_type  TEXT DEFAULT 'automatico',
  p_reversal_of BIGINT DEFAULT NULL
)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  v_id      BIGINT;
  v_debit   NUMERIC(14,2);
  v_credit  NUMERIC(14,2);
BEGIN
  IF p_source_id IS NOT NULL AND p_entry_type <> 'reversion' THEN
    v_id := accounting.source_entry(p_tenant, p_module, p_source_id, p_event);
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  END IF;

  SELECT coalesce(sum(round(coalesce(NULLIF(l->>'debit', '')::NUMERIC, 0), 2)), 0),
         coalesce(sum(round(coalesce(NULLIF(l->>'credit', '')::NUMERIC, 0), 2)), 0)
  INTO v_debit, v_credit
  FROM jsonb_array_elements(coalesce(p_lines, '[]')) l;

  IF v_debit = 0 AND v_credit = 0 THEN RETURN NULL; END IF;
  IF v_debit <> v_credit THEN
    RAISE EXCEPTION 'Asiento descuadrado (%): debe % ≠ haber %', p_event, v_debit, v_credit USING ERRCODE = '23514';
  END IF;
  PERFORM accounting.assert_period_open(p_tenant, p_date);

  INSERT INTO accounting.journal_entries (tenant_id, entry_number, entry_date, entry_type, concept, source_module, source_id,
                                          source_ref, event_type, status, total_debit, total_credit, reversal_of,
                                          created_by, created_by_name, posted_at, posted_by)
  VALUES (p_tenant, accounting.next_number(p_tenant, 'journal'), p_date, p_entry_type, coalesce(NULLIF(btrim(p_concept), ''), p_event),
          p_module, p_source_id, p_source_ref, p_event, 'contabilizado', v_debit, v_credit, p_reversal_of,
          accounting.ctx_user(), accounting.ctx_user_name(), NOW(), accounting.ctx_user())
  ON CONFLICT (tenant_id, source_module, source_id, event_type)
    WHERE source_id IS NOT NULL AND entry_type <> 'reversion' AND status <> 'anulado' DO NOTHING
  RETURNING id INTO v_id;

  -- Perdió una carrera contra el mismo evento: el otro lo contabilizó
  IF v_id IS NULL THEN
    RETURN accounting.source_entry(p_tenant, p_module, p_source_id, p_event);
  END IF;

  PERFORM accounting.insert_lines(p_tenant, v_id, p_lines, true);
  RETURN v_id;
END;
$$;

/**
 * Anula un asiento contabilizando su espejo. El original queda ANULADO con
 * quién/cuándo/por qué y enlazado en ambos sentidos.
 * Fecha de la reversión: la indicada; si no, la del asiento original cuando su
 * período sigue abierto (así la anulación cae en el mismo mes), o hoy.
 * Idempotente: un asiento ya revertido devuelve su reversión.
 */
CREATE OR REPLACE FUNCTION accounting.reverse_entry(
  p_tenant   BIGINT,
  p_entry_id BIGINT,
  p_reason   TEXT,
  p_event    TEXT,
  p_date     DATE DEFAULT NULL
)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  v_orig  accounting.journal_entries%ROWTYPE;
  v_rev   BIGINT;
  v_lines JSONB;
  v_date  DATE;
BEGIN
  SELECT * INTO v_orig FROM accounting.journal_entries WHERE id = p_entry_id AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Asiento no encontrado' USING ERRCODE = 'P0002'; END IF;
  IF v_orig.reversed_by IS NOT NULL THEN RETURN v_orig.reversed_by; END IF;
  IF v_orig.status NOT IN ('contabilizado', 'revisado') THEN
    RAISE EXCEPTION 'Solo se anulan asientos contabilizados' USING ERRCODE = '22023';
  END IF;
  IF coalesce(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'Indica el motivo de la anulación' USING ERRCODE = '22023';
  END IF;

  v_date := coalesce(p_date,
    CASE WHEN accounting.period_is_open(p_tenant, v_orig.entry_date) THEN v_orig.entry_date ELSE accounting.today() END);

  SELECT jsonb_agg(jsonb_build_object(
           'account_id', account_id, 'debit', credit, 'credit', debit, 'description', description,
           'party_id', party_id, 'cost_center', cost_center,
           'reference', reference, 'source_line_id', source_line_id) ORDER BY line_no)
  INTO v_lines FROM accounting.journal_lines WHERE entry_id = v_orig.id;

  -- La reversión acepta cuentas que se desactivaron después del asiento original
  INSERT INTO accounting.journal_entries (tenant_id, entry_number, entry_date, entry_type, concept, source_module, source_id,
                                          source_ref, event_type, status, total_debit, total_credit, reversal_of,
                                          created_by, created_by_name, posted_at, posted_by)
  VALUES (p_tenant, accounting.next_number(p_tenant, 'journal'), v_date, 'reversion',
          'Reversión del asiento #' || lpad(v_orig.entry_number::TEXT, 6, '0') || ' · ' || btrim(p_reason),
          coalesce(v_orig.source_module, 'manual'), coalesce(v_orig.source_id, v_orig.id::TEXT), v_orig.source_ref,
          p_event, 'contabilizado', v_orig.total_credit, v_orig.total_debit, v_orig.id,
          accounting.ctx_user(), accounting.ctx_user_name(), NOW(), accounting.ctx_user())
  RETURNING id INTO v_rev;
  PERFORM accounting.assert_period_open(p_tenant, v_date);
  PERFORM accounting.insert_lines(p_tenant, v_rev, v_lines, false);

  UPDATE accounting.journal_entries
  SET status = 'anulado', voided_at = NOW(), voided_by = accounting.ctx_user(), voided_by_name = accounting.ctx_user_name(),
      void_reason = btrim(p_reason), reversed_by = v_rev
  WHERE id = v_orig.id;
  RETURN v_rev;
END;
$$;

/** Asiento vigente (no anulado) de un documento de origen, si existe. */
CREATE OR REPLACE FUNCTION accounting.source_entry(p_tenant BIGINT, p_module TEXT, p_source_id TEXT, p_event TEXT)
RETURNS BIGINT LANGUAGE sql STABLE AS $$
  SELECT id FROM accounting.journal_entries
  WHERE tenant_id = p_tenant AND source_module = p_module AND source_id = p_source_id AND event_type = p_event
    AND entry_type <> 'reversion' AND status IN ('contabilizado', 'revisado');
$$;

/**
 * Anula el asiento vigente de un documento (si lo hay). El documento queda
 * libre para volver a contabilizarse (p.ej. al editar una compra).
 */
CREATE OR REPLACE FUNCTION accounting.reverse_source(p_tenant BIGINT, p_module TEXT, p_source_id TEXT, p_event TEXT, p_reason TEXT)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  v_entry BIGINT;
BEGIN
  v_entry := accounting.source_entry(p_tenant, p_module, p_source_id, p_event);
  IF v_entry IS NULL THEN RETURN NULL; END IF;
  RETURN accounting.reverse_entry(p_tenant, v_entry, p_reason, p_event || '_REVERSED');
END;
$$;

-- =============================================================================
-- PARTIDAS MANUALES (contador): borrador → contabilizada → revisada / anulada
-- =============================================================================
CREATE OR REPLACE FUNCTION accounting.save_manual_entry(
  p_tenant  BIGINT,
  p_id      BIGINT,
  p_date    DATE,
  p_kind    TEXT,
  p_concept TEXT,
  p_notes   TEXT,
  p_lines   JSONB
)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  v_id     BIGINT := p_id;
  v_debit  NUMERIC(14,2);
  v_credit NUMERIC(14,2);
BEGIN
  IF p_date IS NULL THEN RAISE EXCEPTION 'Indica la fecha contable' USING ERRCODE = '22023'; END IF;
  IF coalesce(btrim(p_concept), '') = '' THEN RAISE EXCEPTION 'Indica el concepto' USING ERRCODE = '22023'; END IF;

  IF v_id IS NULL THEN
    INSERT INTO accounting.journal_entries (tenant_id, entry_date, entry_type, manual_kind, concept, source_module, notes,
                                            created_by, created_by_name)
    VALUES (p_tenant, p_date, 'manual', coalesce(p_kind, 'ajuste'), btrim(p_concept), 'manual', NULLIF(btrim(p_notes), ''),
            accounting.ctx_user(), accounting.ctx_user_name())
    RETURNING id INTO v_id;
  ELSE
    UPDATE accounting.journal_entries
    SET entry_date = p_date, manual_kind = coalesce(p_kind, 'ajuste'), concept = btrim(p_concept), notes = NULLIF(btrim(p_notes), '')
    WHERE id = v_id AND tenant_id = p_tenant AND status = 'borrador' AND entry_type = 'manual';
    IF NOT FOUND THEN RAISE EXCEPTION 'Solo se editan partidas manuales en borrador' USING ERRCODE = '22023'; END IF;
    DELETE FROM accounting.journal_lines WHERE entry_id = v_id;
  END IF;

  PERFORM accounting.insert_lines(p_tenant, v_id, p_lines, true);

  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0) INTO v_debit, v_credit FROM accounting.journal_lines WHERE entry_id = v_id;
  UPDATE accounting.journal_entries SET total_debit = v_debit, total_credit = v_credit WHERE id = v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION accounting.post_manual_entry(p_tenant BIGINT, p_id BIGINT)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  v_entry  accounting.journal_entries%ROWTYPE;
  v_number BIGINT;
BEGIN
  SELECT * INTO v_entry FROM accounting.journal_entries WHERE id = p_id AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Partida no encontrada' USING ERRCODE = 'P0002'; END IF;
  IF v_entry.status <> 'borrador' THEN RAISE EXCEPTION 'La partida ya está contabilizada' USING ERRCODE = '22023'; END IF;
  IF (SELECT count(*) FROM accounting.journal_lines WHERE entry_id = p_id) < 2 THEN
    RAISE EXCEPTION 'La partida necesita al menos dos líneas' USING ERRCODE = '22023';
  END IF;
  IF v_entry.total_debit <> v_entry.total_credit OR v_entry.total_debit = 0 THEN
    RAISE EXCEPTION 'No se puede contabilizar: debe % ≠ haber %', v_entry.total_debit, v_entry.total_credit USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id = l.account_id
             WHERE l.entry_id = p_id AND NOT a.is_active) THEN
    RAISE EXCEPTION 'La partida usa una cuenta inactiva' USING ERRCODE = '22023';
  END IF;
  PERFORM accounting.assert_period_open(p_tenant, v_entry.entry_date);
  v_number := accounting.next_number(p_tenant, 'journal');
  UPDATE accounting.journal_entries
  SET status = 'contabilizado', entry_number = v_number, posted_at = NOW(), posted_by = accounting.ctx_user()
  WHERE id = p_id;
  RETURN v_number;
END;
$$;

CREATE OR REPLACE FUNCTION accounting.delete_manual_draft(p_tenant BIGINT, p_id BIGINT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM accounting.journal_entries
  WHERE id = p_id AND tenant_id = p_tenant AND status = 'borrador' AND entry_type = 'manual';
  IF NOT FOUND THEN RAISE EXCEPTION 'Solo se eliminan partidas manuales en borrador' USING ERRCODE = '22023'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION accounting.review_entry(p_tenant BIGINT, p_id BIGINT, p_notes TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE accounting.journal_entries
  SET status = 'revisado', reviewed_at = NOW(), reviewed_by = accounting.ctx_user(), reviewed_by_name = accounting.ctx_user_name(),
      review_notes = NULLIF(btrim(p_notes), '')
  WHERE id = p_id AND tenant_id = p_tenant AND status = 'contabilizado';
  IF NOT FOUND THEN RAISE EXCEPTION 'Solo se revisan asientos contabilizados' USING ERRCODE = '22023'; END IF;
END;
$$;

/** Las partidas manuales se anulan aquí; las automáticas, desde su documento. */
CREATE OR REPLACE FUNCTION accounting.void_manual_entry(p_tenant BIGINT, p_id BIGINT, p_reason TEXT)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  v_entry accounting.journal_entries%ROWTYPE;
BEGIN
  SELECT * INTO v_entry FROM accounting.journal_entries WHERE id = p_id AND tenant_id = p_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'Partida no encontrada' USING ERRCODE = 'P0002'; END IF;
  IF v_entry.entry_type <> 'manual' THEN
    RAISE EXCEPTION 'Los asientos automáticos se anulan desde su documento de origen' USING ERRCODE = '22023';
  END IF;
  RETURN accounting.reverse_entry(p_tenant, p_id, p_reason, 'MANUAL_VOIDED');
END;
$$;

-- =============================================================================
-- CATÁLOGO: importación masiva (CSV ya parseado por el frontend)
-- =============================================================================
/**
 * p_rows: [{code, name, account_type, nature?, parent_code?, financial_statement?,
 *           allows_movements?, is_active?, balance_term?, result_section?}]
 * - Deriva lo que falte: naturaleza y estado financiero desde el tipo; el padre
 *   desde el prefijo de código más largo; "permite movimientos" = no tiene hijos.
 * - Inserta o actualiza por código (upsert). No borra cuentas existentes.
 * Devuelve {inserted, updated}.
 */
CREATE OR REPLACE FUNCTION accounting.import_accounts(p_tenant BIGINT, p_rows JSONB)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_row      RECORD;
  v_parent   BIGINT;
  v_ins      INT := 0;
  v_upd      INT := 0;
  v_existing BIGINT;
  v_type     TEXT;
  v_fs       TEXT;
BEGIN
  DROP TABLE IF EXISTS _imp;
  CREATE TEMP TABLE _imp ON COMMIT DROP AS
  SELECT btrim(r->>'code') AS code,
         btrim(r->>'name') AS name,
         initcap(lower(btrim(r->>'account_type'))) AS account_type,
         NULLIF(initcap(lower(btrim(r->>'nature'))), '') AS nature,
         NULLIF(btrim(r->>'parent_code'), '') AS parent_code,
         NULLIF(btrim(r->>'financial_statement'), '') AS financial_statement,
         CASE WHEN r ? 'allows_movements' AND r->>'allows_movements' IS NOT NULL AND r->>'allows_movements' <> ''
              THEN (r->>'allows_movements')::BOOLEAN END AS allows_movements,
         coalesce(NULLIF(r->>'is_active', '')::BOOLEAN, true) AS is_active,
         NULLIF(btrim(r->>'balance_term'), '') AS balance_term,
         NULLIF(btrim(r->>'result_section'), '') AS result_section,
         ord
  FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(r, ord);

  IF EXISTS (SELECT 1 FROM _imp WHERE code IS NULL OR code = '' OR name IS NULL OR name = '') THEN
    RAISE EXCEPTION 'Hay filas sin código o sin nombre (fila %)',
      (SELECT min(ord) FROM _imp WHERE code IS NULL OR code = '' OR name IS NULL OR name = '') USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT code FROM _imp GROUP BY code HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'El código % está repetido en el archivo', (SELECT code FROM _imp GROUP BY code HAVING count(*) > 1 LIMIT 1)
      USING ERRCODE = '22023';
  END IF;
  -- Tipos en mayúscula/minúscula indistinta; "Contraactivo" también como "Contra activo"
  UPDATE _imp SET account_type = 'Contraactivo' WHERE replace(account_type, ' ', '') ILIKE 'contraactivo';
  IF EXISTS (SELECT 1 FROM _imp WHERE account_type NOT IN ('Activo', 'Contraactivo', 'Pasivo', 'Patrimonio', 'Ingreso', 'Costo', 'Gasto', 'Resultado')) THEN
    RAISE EXCEPTION 'Tipo de cuenta inválido «%» en %: usa Activo, Contraactivo, Pasivo, Patrimonio, Ingreso, Costo, Gasto o Resultado',
      (SELECT account_type FROM _imp WHERE account_type NOT IN ('Activo', 'Contraactivo', 'Pasivo', 'Patrimonio', 'Ingreso', 'Costo', 'Gasto', 'Resultado') LIMIT 1),
      (SELECT code FROM _imp WHERE account_type NOT IN ('Activo', 'Contraactivo', 'Pasivo', 'Patrimonio', 'Ingreso', 'Costo', 'Gasto', 'Resultado') LIMIT 1)
      USING ERRCODE = '22023';
  END IF;

  -- Padre: el indicado, o el código más largo (del archivo o del catálogo) que sea prefijo
  UPDATE _imp i SET parent_code = (
    SELECT c.code FROM (
      SELECT code FROM _imp
      UNION SELECT code FROM accounting.accounts WHERE tenant_id = p_tenant
    ) c
    WHERE c.code <> i.code AND left(i.code, length(c.code)) = c.code
    ORDER BY length(c.code) DESC LIMIT 1)
  WHERE parent_code IS NULL;

  -- Cuentas con hijos en el archivo son de mayor
  UPDATE _imp i SET allows_movements = NOT EXISTS (SELECT 1 FROM _imp c WHERE c.parent_code = i.code)
  WHERE allows_movements IS NULL;

  -- Insertar padres antes que hijos
  FOR v_row IN
    WITH RECURSIVE depth AS (
      SELECT code, 1 AS d FROM _imp WHERE parent_code IS NULL OR parent_code NOT IN (SELECT code FROM _imp)
      UNION ALL
      SELECT i.code, depth.d + 1 FROM _imp i JOIN depth ON i.parent_code = depth.code
    )
    SELECT i.*, d.d FROM _imp i JOIN depth d ON d.code = i.code ORDER BY d.d, i.ord
  LOOP
    v_type := v_row.account_type;
    v_fs := coalesce(v_row.financial_statement,
      CASE WHEN v_type IN ('Ingreso', 'Costo', 'Gasto', 'Resultado') THEN 'ER' ELSE 'Balance' END);
    IF v_fs ILIKE 'estado%resultado%' OR v_fs ILIKE 'er' THEN v_fs := 'ER'; END IF;
    IF v_fs ILIKE 'balance%' THEN v_fs := 'Balance'; END IF;
    IF v_fs NOT IN ('ER', 'Balance') THEN
      RAISE EXCEPTION 'Estado financiero inválido «%» en %', v_fs, v_row.code USING ERRCODE = '22023';
    END IF;

    v_parent := NULL;
    IF v_row.parent_code IS NOT NULL THEN
      SELECT id INTO v_parent FROM accounting.accounts WHERE tenant_id = p_tenant AND code = v_row.parent_code;
      IF v_parent IS NULL THEN
        RAISE EXCEPTION 'La cuenta padre % de % no existe', v_row.parent_code, v_row.code USING ERRCODE = '22023';
      END IF;
      -- Un padre existente que permitía movimientos y aún no tiene, pasa a mayor
      UPDATE accounting.accounts SET allows_movements = false
      WHERE id = v_parent AND allows_movements
        AND NOT EXISTS (SELECT 1 FROM accounting.journal_lines WHERE account_id = v_parent);
    END IF;

    SELECT id INTO v_existing FROM accounting.accounts WHERE tenant_id = p_tenant AND code = v_row.code;
    IF v_existing IS NULL THEN
      INSERT INTO accounting.accounts (tenant_id, code, name, account_type, nature, parent_id, financial_statement,
                                       affects_result, result_section, balance_term, allows_movements, is_active, created_by)
      VALUES (p_tenant, v_row.code, v_row.name, v_type,
              coalesce(v_row.nature, CASE WHEN v_type IN ('Activo', 'Costo', 'Gasto') THEN 'Deudora'
                                          WHEN v_type = 'Resultado' THEN 'Mixta' ELSE 'Acreedora' END),
              v_parent, v_fs, v_fs = 'ER', v_row.result_section, v_row.balance_term, v_row.allows_movements,
              v_row.is_active, accounting.ctx_user());
      v_ins := v_ins + 1;
    ELSE
      UPDATE accounting.accounts SET
        name = v_row.name, account_type = v_type,
        nature = coalesce(v_row.nature, nature), parent_id = v_parent, financial_statement = v_fs,
        affects_result = (v_fs = 'ER'), result_section = coalesce(v_row.result_section, result_section),
        balance_term = coalesce(v_row.balance_term, balance_term),
        allows_movements = v_row.allows_movements, is_active = v_row.is_active
      WHERE id = v_existing;
      v_upd := v_upd + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('inserted', v_ins, 'updated', v_upd);
END;
$$;

-- =============================================================================
-- REPORTES
-- =============================================================================
/** Movimientos por cuenta: antes del período y dentro de él (base de balanza y estados). */
CREATE OR REPLACE FUNCTION accounting.account_movements(p_tenant BIGINT, p_from DATE, p_to DATE)
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
  GROUP BY l.account_id;
$$;

/** Libro mayor de una cuenta (o de todas sus subcuentas) en un rango. */
CREATE OR REPLACE FUNCTION accounting.account_ledger(p_tenant BIGINT, p_account_id BIGINT, p_from DATE, p_to DATE)
RETURNS TABLE (
  entry_id BIGINT, entry_number BIGINT, entry_date DATE, entry_type TEXT, status TEXT, concept TEXT, source_ref TEXT,
  line_no INT, account_id BIGINT, account_code TEXT, account_name TEXT, description TEXT, party_name TEXT,
  debit NUMERIC, credit NUMERIC
)
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE tree AS (
    SELECT id FROM accounting.accounts WHERE id = p_account_id AND tenant_id = p_tenant
    UNION ALL
    SELECT a.id FROM accounting.accounts a JOIN tree t ON a.parent_id = t.id
  )
  SELECT e.id, e.entry_number, e.entry_date, e.entry_type, e.status, e.concept, e.source_ref,
         l.line_no, a.id, a.code, a.name, l.description, c.nombre, l.debit, l.credit
  FROM accounting.journal_lines l
  JOIN tree t ON t.id = l.account_id
  JOIN accounting.accounts a ON a.id = l.account_id
  JOIN accounting.journal_entries e ON e.id = l.entry_id
  LEFT JOIN public.contribuyentes c ON c.id = l.party_id
  WHERE e.tenant_id = p_tenant AND e.status <> 'borrador' AND e.entry_date BETWEEN p_from AND p_to
  ORDER BY e.entry_date, e.entry_number, l.line_no
$$;

/** Saldo (debe − haber) de una cuenta y sus subcuentas antes de una fecha. */
CREATE OR REPLACE FUNCTION accounting.account_balance_before(p_tenant BIGINT, p_account_id BIGINT, p_date DATE)
RETURNS NUMERIC LANGUAGE sql STABLE AS $$
  WITH RECURSIVE tree AS (
    SELECT id FROM accounting.accounts WHERE id = p_account_id AND tenant_id = p_tenant
    UNION ALL
    SELECT a.id FROM accounting.accounts a JOIN tree t ON a.parent_id = t.id
  )
  SELECT coalesce(sum(l.debit - l.credit), 0)
  FROM accounting.journal_lines l
  JOIN tree t ON t.id = l.account_id
  JOIN accounting.journal_entries e ON e.id = l.entry_id
  WHERE e.tenant_id = p_tenant AND e.status <> 'borrador' AND e.entry_date < p_date
$$;
