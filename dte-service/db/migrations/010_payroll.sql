-- =============================================================================
-- 010_payroll — Planillas (F5). Portado de ChuchoWash (0046) y generalizado.
--
-- Ley de El Salvador (parámetros editables por empresa, la ley cambia):
--  * ISSS 3% trabajador / 7.5% patrono, tope de cotización $1,000 mensual.
--  * AFP 7.25% / 8.75% (tope opcional). INSAFORP 1% patronal (si aplica).
--  * Renta: tablas de retención de la reforma del 30-abr-2025 sobre salario
--    menos ISSS y AFP del trabajador.
--  * Horas extra +100% (nocturnas +25% adicional), asueto trabajado +100%,
--    prima de vacaciones 30% sobre 15 días.
--  * Aguinaldo 15/19/21 días según antigüedad (proporcional < 1 año), exento
--    de ISSS/AFP y de renta hasta el límite.
--  * Despido sin causa (Art. 58 CT): 30 días por año, salario tope 4 salarios
--    mínimos, mínimo 15 días. Renuncia voluntaria: 15 días por año con 2+
--    años, tope 2 salarios mínimos. Exentas de renta, ISSS y AFP.
--  * Calendario comercial de 30 días.
--
-- Generalización: en lugar de las áreas fijas de ChuchoWash (grooming,
-- delivery, administrativo), cada empresa define CENTROS DE COSTO con sus
-- propias cuentas de sueldos y aportes patronales (o usa los roles generales).
-- Emitir una planilla o una liquidación contabiliza su asiento; pagarlas
-- registra la salida del banco (conciliable en Bancos).
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS payroll;

-- ── Roles contables de planilla (cuentas generales; los centros de costo pueden sobrescribirlas) ──
INSERT INTO accounting.role_definitions (role_key, label, group_name, description, sort_order) VALUES
  ('payroll_salary',           'Sueldos y salarios',            'Planillas', 'Gasto de sueldos si el centro de costo no define otra cuenta', 70),
  ('payroll_isss_employer',    'ISSS patronal',                 'Planillas', 'Incluye INSAFORP si aplica', 71),
  ('payroll_afp_employer',     'AFP patronal',                  'Planillas', NULL, 72),
  ('payroll_benefits',         'Prestaciones laborales',        'Planillas', 'Aguinaldo, vacaciones e indemnizaciones', 73),
  ('payroll_payable',          'Sueldos por pagar',             'Planillas', 'Líquido a pagar a los empleados', 74),
  ('payroll_isss_payable',     'ISSS por pagar',                'Planillas', 'Cuota laboral + patronal (+ INSAFORP)', 75),
  ('payroll_afp_payable',      'AFP por pagar',                 'Planillas', 'Cotización laboral + patronal', 76),
  ('payroll_other_deductions', 'Otros descuentos por pagar',    'Planillas', 'Préstamos, embargos, procuraduría…', 77)
ON CONFLICT (role_key) DO NOTHING;

-- =============================================================================
-- PARÁMETROS DE LEY Y TABLAS DE RENTA (por empresa)
-- =============================================================================
CREATE TABLE payroll.settings (
  tenant_id           BIGINT PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  isss_employee_rate  NUMERIC(6,4) NOT NULL DEFAULT 0.03   CHECK (isss_employee_rate BETWEEN 0 AND 1),
  isss_employer_rate  NUMERIC(6,4) NOT NULL DEFAULT 0.075  CHECK (isss_employer_rate BETWEEN 0 AND 1),
  isss_cap            NUMERIC(10,2) NOT NULL DEFAULT 1000  CHECK (isss_cap > 0),
  afp_employee_rate   NUMERIC(6,4) NOT NULL DEFAULT 0.0725 CHECK (afp_employee_rate BETWEEN 0 AND 1),
  afp_employer_rate   NUMERIC(6,4) NOT NULL DEFAULT 0.0875 CHECK (afp_employer_rate BETWEEN 0 AND 1),
  afp_cap             NUMERIC(10,2) CHECK (afp_cap IS NULL OR afp_cap > 0),
  insaforp_applies    BOOLEAN NOT NULL DEFAULT false,
  insaforp_rate       NUMERIC(6,4) NOT NULL DEFAULT 0.01   CHECK (insaforp_rate BETWEEN 0 AND 1),
  minimum_wage        NUMERIC(10,2) NOT NULL DEFAULT 408.80 CHECK (minimum_wage > 0),
  aguinaldo_exempt    NUMERIC(10,2) NOT NULL DEFAULT 1500  CHECK (aguinaldo_exempt >= 0),
  workday_hours       NUMERIC(4,2) NOT NULL DEFAULT 8      CHECK (workday_hours > 0),
  overtime_surcharge  NUMERIC(6,4) NOT NULL DEFAULT 1.00   CHECK (overtime_surcharge >= 0),
  night_surcharge     NUMERIC(6,4) NOT NULL DEFAULT 0.25   CHECK (night_surcharge >= 0),
  holiday_surcharge   NUMERIC(6,4) NOT NULL DEFAULT 1.00   CHECK (holiday_surcharge >= 0),
  vacation_premium    NUMERIC(6,4) NOT NULL DEFAULT 0.30   CHECK (vacation_premium >= 0),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by          TEXT
);

CREATE TABLE payroll.isr_brackets (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  frequency   TEXT NOT NULL CHECK (frequency IN ('mensual', 'quincenal')),
  tramo       INT NOT NULL CHECK (tramo > 0),
  lower_limit NUMERIC(12,2) NOT NULL CHECK (lower_limit >= 0),
  rate        NUMERIC(6,4) NOT NULL CHECK (rate BETWEEN 0 AND 1),
  excess_over NUMERIC(12,2) NOT NULL DEFAULT 0,
  fixed_fee   NUMERIC(12,2) NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, frequency, tramo)
);

CREATE TABLE payroll.cost_centers (
  id                 BIGSERIAL PRIMARY KEY,
  tenant_id          BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name               TEXT NOT NULL CHECK (btrim(name) <> ''),
  salary_account_id  BIGINT REFERENCES accounting.accounts(id),
  isss_account_id    BIGINT REFERENCES accounting.accounts(id),
  afp_account_id     BIGINT REFERENCES accounting.accounts(id),
  is_active          BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (tenant_id, name)
);

/** Parámetros, tabla de renta 2025 y un centro de costo "General" para una empresa; conserva lo existente. */
CREATE OR REPLACE FUNCTION payroll.ensure_settings(p_tenant BIGINT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO payroll.settings (tenant_id) VALUES (p_tenant) ON CONFLICT DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM payroll.isr_brackets WHERE tenant_id = p_tenant) THEN
    INSERT INTO payroll.isr_brackets (tenant_id, frequency, tramo, lower_limit, rate, excess_over, fixed_fee) VALUES
      (p_tenant, 'mensual',   1,    0.01, 0.00,    0.00,   0.00),
      (p_tenant, 'mensual',   2,  550.01, 0.10,  550.00,  17.67),
      (p_tenant, 'mensual',   3,  895.25, 0.20,  895.24,  60.00),
      (p_tenant, 'mensual',   4, 2038.11, 0.30, 2038.10, 288.57),
      (p_tenant, 'quincenal', 1,    0.01, 0.00,    0.00,   0.00),
      (p_tenant, 'quincenal', 2,  275.01, 0.10,  275.00,   8.83),
      (p_tenant, 'quincenal', 3,  447.63, 0.20,  447.62,  30.00),
      (p_tenant, 'quincenal', 4, 1019.06, 0.30, 1019.05, 144.28);
  END IF;
  INSERT INTO payroll.cost_centers (tenant_id, name) VALUES (p_tenant, 'General') ON CONFLICT DO NOTHING;
END;
$$;

/** Renta a retener: cuota fija + (base − exceso) × tasa del tramo más alto con límite ≤ base. */
CREATE OR REPLACE FUNCTION payroll.isr_retention(p_tenant BIGINT, p_frequency TEXT, p_base NUMERIC)
RETURNS NUMERIC LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN coalesce(p_base, 0) <= 0 THEN 0 ELSE coalesce((
    SELECT greatest(round(fixed_fee + (p_base - excess_over) * rate, 2), 0)
    FROM payroll.isr_brackets
    WHERE tenant_id = p_tenant AND frequency = p_frequency AND lower_limit <= p_base
    ORDER BY lower_limit DESC LIMIT 1), 0) END
$$;

-- =============================================================================
-- EMPLEADOS
-- =============================================================================
CREATE TABLE payroll.employees (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  employee_code    TEXT,
  first_name       TEXT NOT NULL CHECK (btrim(first_name) <> ''),
  last_name        TEXT NOT NULL CHECK (btrim(last_name) <> ''),
  full_name        TEXT GENERATED ALWAYS AS (first_name || ' ' || last_name) STORED,
  dui              TEXT CHECK (dui IS NULL OR dui ~ '^\d{8}-\d$'),
  nit              TEXT,
  isss_number      TEXT,
  nup              TEXT,
  afp_name         TEXT CHECK (afp_name IS NULL OR afp_name IN ('confia', 'crecer')),
  birth_date       DATE,
  phone            TEXT,
  email            TEXT,
  address          TEXT,
  position         TEXT NOT NULL CHECK (btrim(position) <> ''),
  cost_center_id   BIGINT NOT NULL REFERENCES payroll.cost_centers(id),
  hire_date        DATE NOT NULL,
  monthly_salary   NUMERIC(10,2) NOT NULL CHECK (monthly_salary > 0),
  pay_frequency    TEXT NOT NULL DEFAULT 'mensual' CHECK (pay_frequency IN ('mensual', 'quincenal')),
  payment_method   TEXT NOT NULL DEFAULT 'transferencia' CHECK (payment_method IN ('transferencia', 'efectivo', 'cheque')),
  bank_name        TEXT,
  bank_account     TEXT,
  applies_isss     BOOLEAN NOT NULL DEFAULT true,
  applies_afp      BOOLEAN NOT NULL DEFAULT true,
  applies_isr      BOOLEAN NOT NULL DEFAULT true,
  status           TEXT NOT NULL DEFAULT 'activo' CHECK (status IN ('activo', 'retirado')),
  termination_date DATE,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (termination_date IS NULL OR termination_date >= hire_date),
  CHECK ((status = 'retirado') = (termination_date IS NOT NULL))
);
CREATE INDEX idx_employees_tenant ON payroll.employees(tenant_id, status);
CREATE UNIQUE INDEX idx_employees_dui ON payroll.employees(tenant_id, dui) WHERE dui IS NOT NULL;

-- =============================================================================
-- PLANILLAS Y BOLETAS
-- =============================================================================
CREATE TABLE payroll.payrolls (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  payroll_number   BIGINT,
  kind             TEXT NOT NULL CHECK (kind IN ('ordinaria', 'aguinaldo')),
  frequency        TEXT NOT NULL CHECK (frequency IN ('mensual', 'quincenal')),
  period_start     DATE NOT NULL,
  period_end       DATE NOT NULL,
  payment_date     DATE NOT NULL,
  status           TEXT NOT NULL DEFAULT 'borrador' CHECK (status IN ('borrador', 'emitida', 'anulada')),
  notes            TEXT,
  employees        INT NOT NULL DEFAULT 0,
  gross            NUMERIC(12,2) NOT NULL DEFAULT 0,
  isss_employee    NUMERIC(12,2) NOT NULL DEFAULT 0,
  afp_employee     NUMERIC(12,2) NOT NULL DEFAULT 0,
  isr              NUMERIC(12,2) NOT NULL DEFAULT 0,
  other_deductions NUMERIC(12,2) NOT NULL DEFAULT 0,
  net              NUMERIC(12,2) NOT NULL DEFAULT 0,
  isss_employer    NUMERIC(12,2) NOT NULL DEFAULT 0,
  afp_employer     NUMERIC(12,2) NOT NULL DEFAULT 0,
  insaforp         NUMERIC(12,2) NOT NULL DEFAULT 0,
  journal_entry_id BIGINT REFERENCES accounting.journal_entries(id),
  paid_entry_id    BIGINT REFERENCES accounting.journal_entries(id),
  paid_at          DATE,
  created_by_name  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  emitted_at       TIMESTAMPTZ,
  emitted_by_name  TEXT,
  voided_at        TIMESTAMPTZ,
  voided_by_name   TEXT,
  void_reason      TEXT,
  CHECK (period_end >= period_start),
  UNIQUE (tenant_id, payroll_number)
);
CREATE INDEX idx_payrolls_tenant ON payroll.payrolls(tenant_id, period_end DESC);

CREATE TABLE payroll.payroll_lines (
  id                   BIGSERIAL PRIMARY KEY,
  payroll_id           BIGINT NOT NULL REFERENCES payroll.payrolls(id) ON DELETE CASCADE,
  tenant_id            BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  employee_id          BIGINT NOT NULL REFERENCES payroll.employees(id),
  employee_name        TEXT NOT NULL,
  employee_code        TEXT,
  dui                  TEXT,
  nit                  TEXT,
  isss_number          TEXT,
  nup                  TEXT,
  afp_name             TEXT,
  position             TEXT,
  cost_center_id       BIGINT NOT NULL REFERENCES payroll.cost_centers(id),
  hire_date            DATE NOT NULL,
  monthly_salary       NUMERIC(10,2) NOT NULL,
  payment_method       TEXT,
  bank_name            TEXT,
  bank_account         TEXT,
  applies_isss         BOOLEAN NOT NULL,
  applies_afp          BOOLEAN NOT NULL,
  applies_isr          BOOLEAN NOT NULL,
  period_days          NUMERIC(6,2) NOT NULL DEFAULT 0,
  absence_days         NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (absence_days >= 0),
  overtime_day_hours   NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (overtime_day_hours >= 0),
  overtime_night_hours NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (overtime_night_hours >= 0),
  holiday_days         NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (holiday_days >= 0),
  vacation             BOOLEAN NOT NULL DEFAULT false,
  bonuses              NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (bonuses >= 0),
  bonuses_note         TEXT,
  other_deductions     NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (other_deductions >= 0),
  deductions_note      TEXT,
  days_paid            NUMERIC(6,2) NOT NULL DEFAULT 0,
  aguinaldo_days       NUMERIC(8,4) NOT NULL DEFAULT 0,
  base_salary          NUMERIC(10,2) NOT NULL DEFAULT 0,
  overtime_pay         NUMERIC(10,2) NOT NULL DEFAULT 0,
  holiday_pay          NUMERIC(10,2) NOT NULL DEFAULT 0,
  vacation_pay         NUMERIC(10,2) NOT NULL DEFAULT 0,
  aguinaldo            NUMERIC(10,2) NOT NULL DEFAULT 0,
  gross                NUMERIC(10,2) NOT NULL DEFAULT 0,
  isss_base            NUMERIC(10,2) NOT NULL DEFAULT 0,
  isss_employee        NUMERIC(10,2) NOT NULL DEFAULT 0,
  afp_base             NUMERIC(10,2) NOT NULL DEFAULT 0,
  afp_employee         NUMERIC(10,2) NOT NULL DEFAULT 0,
  isr_base             NUMERIC(10,2) NOT NULL DEFAULT 0,
  isr                  NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_deductions     NUMERIC(10,2) NOT NULL DEFAULT 0,
  net                  NUMERIC(10,2) NOT NULL DEFAULT 0,
  isss_employer        NUMERIC(10,2) NOT NULL DEFAULT 0,
  afp_employer         NUMERIC(10,2) NOT NULL DEFAULT 0,
  insaforp             NUMERIC(10,2) NOT NULL DEFAULT 0,
  UNIQUE (payroll_id, employee_id)
);
CREATE INDEX idx_payroll_lines_employee ON payroll.payroll_lines(employee_id);

/** Días entre dos fechas (inclusive) en calendario comercial de 30 días. */
CREATE OR REPLACE FUNCTION payroll.commercial_days(p_from DATE, p_to DATE)
RETURNS INT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_to < p_from THEN 0 ELSE greatest(
    (extract(year FROM p_to) - extract(year FROM p_from))::INT * 360
    + (extract(month FROM p_to) - extract(month FROM p_from))::INT * 30
    + CASE WHEN p_to = (date_trunc('month', p_to) + INTERVAL '1 month - 1 day')::DATE THEN 30
           ELSE least(extract(day FROM p_to)::INT, 30) END
    - least(extract(day FROM p_from)::INT, 30) + 1, 0) END
$$;

/** Días de aguinaldo según antigüedad: 15 / 19 / 21; proporcional a 15 con menos de un año. */
CREATE OR REPLACE FUNCTION payroll.aguinaldo_days(p_hire DATE, p_at DATE)
RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_at < p_hire THEN 0
    WHEN extract(year FROM age(p_at, p_hire)) < 1 THEN round(15 * (p_at - p_hire + 1) / 365.0, 4)
    WHEN extract(year FROM age(p_at, p_hire)) < 3 THEN 15
    WHEN extract(year FROM age(p_at, p_hire)) < 10 THEN 19
    ELSE 21 END
$$;

CREATE OR REPLACE FUNCTION payroll.compute_line(p_line_id BIGINT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  l          payroll.payroll_lines%ROWTYPE;
  p          payroll.payrolls%ROWTYPE;
  s          payroll.settings%ROWTYPE;
  v_nominal  INT;
  v_factor   NUMERIC;
  v_daily    NUMERIC;
  v_hourly   NUMERIC;
  v_days     NUMERIC;
  v_cot      NUMERIC;
BEGIN
  SELECT * INTO l FROM payroll.payroll_lines WHERE id = p_line_id FOR UPDATE;
  SELECT * INTO p FROM payroll.payrolls WHERE id = l.payroll_id;
  SELECT * INTO s FROM payroll.settings WHERE tenant_id = p.tenant_id;

  v_daily  := l.monthly_salary / 30;
  v_hourly := v_daily / s.workday_hours;
  v_nominal := CASE p.frequency WHEN 'mensual' THEN 30 ELSE 15 END;
  v_factor := v_nominal / 30.0;

  l.base_salary := 0; l.overtime_pay := 0; l.holiday_pay := 0; l.vacation_pay := 0; l.aguinaldo := 0;
  l.aguinaldo_days := 0; l.days_paid := 0;
  IF p.kind = 'ordinaria' THEN
    v_days := greatest(l.period_days - l.absence_days, 0);
    l.days_paid := v_days;
    l.base_salary := CASE WHEN v_days = v_nominal THEN round(l.monthly_salary * v_factor, 2) ELSE round(v_daily * v_days, 2) END;
    l.overtime_pay := round(v_hourly * (1 + s.overtime_surcharge) * l.overtime_day_hours
                          + v_hourly * (1 + s.night_surcharge) * (1 + s.overtime_surcharge) * l.overtime_night_hours, 2);
    l.holiday_pay := round(v_daily * (1 + s.holiday_surcharge) * l.holiday_days, 2);
    l.vacation_pay := CASE WHEN l.vacation THEN round(v_daily * 15 * s.vacation_premium, 2) ELSE 0 END;
  ELSE
    l.aguinaldo_days := payroll.aguinaldo_days(l.hire_date, p.period_end);
    l.aguinaldo := round(v_daily * l.aguinaldo_days, 2);
  END IF;
  l.gross := l.base_salary + l.overtime_pay + l.holiday_pay + l.vacation_pay + l.aguinaldo + l.bonuses;

  -- ISSS y AFP sobre todo menos el aguinaldo; los topes son mensuales
  v_cot := l.gross - l.aguinaldo;
  l.isss_base := CASE WHEN l.applies_isss THEN least(v_cot, round(s.isss_cap * v_factor, 2)) ELSE 0 END;
  l.afp_base  := CASE WHEN l.applies_afp THEN
                   CASE WHEN s.afp_cap IS NULL THEN v_cot ELSE least(v_cot, round(s.afp_cap * v_factor, 2)) END ELSE 0 END;
  l.isss_employee := round(l.isss_base * s.isss_employee_rate, 2);
  l.isss_employer := round(l.isss_base * s.isss_employer_rate, 2);
  l.afp_employee  := round(l.afp_base * s.afp_employee_rate, 2);
  l.afp_employer  := round(l.afp_base * s.afp_employer_rate, 2);
  l.insaforp      := CASE WHEN s.insaforp_applies AND l.applies_isss THEN round(v_cot * s.insaforp_rate, 2) ELSE 0 END;

  -- Renta: aguinaldo exento hasta el límite
  l.isr_base := greatest(v_cot - l.isss_employee - l.afp_employee + greatest(l.aguinaldo - s.aguinaldo_exempt, 0), 0);
  l.isr := CASE WHEN l.applies_isr THEN payroll.isr_retention(p.tenant_id, p.frequency, l.isr_base) ELSE 0 END;

  l.total_deductions := l.isss_employee + l.afp_employee + l.isr + l.other_deductions;
  l.net := l.gross - l.total_deductions;
  IF l.net < 0 THEN
    RAISE EXCEPTION 'Los descuentos de % superan lo devengado', l.employee_name USING ERRCODE = '22023';
  END IF;

  UPDATE payroll.payroll_lines SET
    days_paid = l.days_paid, aguinaldo_days = l.aguinaldo_days, base_salary = l.base_salary,
    overtime_pay = l.overtime_pay, holiday_pay = l.holiday_pay, vacation_pay = l.vacation_pay,
    aguinaldo = l.aguinaldo, gross = l.gross, isss_base = l.isss_base, isss_employee = l.isss_employee,
    afp_base = l.afp_base, afp_employee = l.afp_employee, isr_base = l.isr_base, isr = l.isr,
    total_deductions = l.total_deductions, net = l.net, isss_employer = l.isss_employer,
    afp_employer = l.afp_employer, insaforp = l.insaforp
  WHERE id = l.id;
END;
$$;

CREATE OR REPLACE FUNCTION payroll.refresh_totals(p_payroll_id BIGINT)
RETURNS VOID LANGUAGE sql AS $$
  UPDATE payroll.payrolls p SET
    employees = t.n, gross = t.gross, isss_employee = t.isss_e, afp_employee = t.afp_e, isr = t.isr,
    other_deductions = t.other, net = t.net, isss_employer = t.isss_r, afp_employer = t.afp_r, insaforp = t.insaforp
  FROM (SELECT count(*) n, coalesce(sum(gross), 0) gross, coalesce(sum(isss_employee), 0) isss_e,
               coalesce(sum(afp_employee), 0) afp_e, coalesce(sum(isr), 0) isr, coalesce(sum(other_deductions), 0) other,
               coalesce(sum(net), 0) net, coalesce(sum(isss_employer), 0) isss_r, coalesce(sum(afp_employer), 0) afp_r,
               coalesce(sum(insaforp), 0) insaforp
        FROM payroll.payroll_lines WHERE payroll_id = p_payroll_id) t
  WHERE p.id = p_payroll_id
$$;

/** Ajusta un borrador a los empleados: agrega a los del período, refresca sus datos y recalcula (conserva lo digitado). */
CREATE OR REPLACE FUNCTION payroll.sync_lines(p_payroll_id BIGINT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  p         payroll.payrolls%ROWTYPE;
  v_nominal INT;
  v_line    BIGINT;
BEGIN
  SELECT * INTO p FROM payroll.payrolls WHERE id = p_payroll_id FOR UPDATE;
  v_nominal := CASE p.frequency WHEN 'mensual' THEN 30 ELSE 15 END;

  INSERT INTO payroll.payroll_lines (payroll_id, tenant_id, employee_id, employee_name, cost_center_id, hire_date, monthly_salary,
                                     applies_isss, applies_afp, applies_isr)
  SELECT p.id, p.tenant_id, e.id, e.full_name, e.cost_center_id, e.hire_date, e.monthly_salary, e.applies_isss, e.applies_afp, e.applies_isr
  FROM payroll.employees e
  WHERE e.tenant_id = p.tenant_id AND e.hire_date <= p.period_end
    AND (e.termination_date IS NULL OR e.termination_date >= CASE p.kind WHEN 'aguinaldo' THEN p.period_end ELSE p.period_start END)
    AND (p.kind = 'aguinaldo' OR e.pay_frequency = p.frequency)
  ON CONFLICT (payroll_id, employee_id) DO NOTHING;

  UPDATE payroll.payroll_lines l SET
    employee_name = e.full_name, employee_code = e.employee_code, dui = e.dui, nit = e.nit, isss_number = e.isss_number, nup = e.nup,
    afp_name = e.afp_name, position = e.position, cost_center_id = e.cost_center_id, hire_date = e.hire_date,
    monthly_salary = e.monthly_salary, payment_method = e.payment_method, bank_name = e.bank_name, bank_account = e.bank_account,
    applies_isss = e.applies_isss, applies_afp = e.applies_afp, applies_isr = e.applies_isr,
    period_days = CASE WHEN p.kind = 'aguinaldo' THEN 0
      WHEN e.hire_date <= p.period_start AND coalesce(e.termination_date, p.period_end) >= p.period_end THEN v_nominal
      ELSE least(v_nominal, payroll.commercial_days(greatest(p.period_start, e.hire_date),
                                                    least(p.period_end, coalesce(e.termination_date, p.period_end)))) END
  FROM payroll.employees e
  WHERE l.payroll_id = p.id AND e.id = l.employee_id;

  FOR v_line IN SELECT id FROM payroll.payroll_lines WHERE payroll_id = p.id LOOP
    PERFORM payroll.compute_line(v_line);
  END LOOP;
  PERFORM payroll.refresh_totals(p.id);
END;
$$;

CREATE OR REPLACE FUNCTION payroll.assert_draft(p_tenant BIGINT, p_payroll_id BIGINT)
RETURNS payroll.payrolls LANGUAGE plpgsql AS $$
DECLARE
  p payroll.payrolls%ROWTYPE;
BEGIN
  SELECT * INTO p FROM payroll.payrolls WHERE id = p_payroll_id AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Planilla no encontrada' USING ERRCODE = 'P0002'; END IF;
  IF p.status <> 'borrador' THEN
    RAISE EXCEPTION 'La planilla ya está %; no se puede modificar', p.status USING ERRCODE = '22023';
  END IF;
  RETURN p;
END;
$$;

CREATE OR REPLACE FUNCTION payroll.create_payroll(
  p_tenant BIGINT, p_kind TEXT, p_frequency TEXT, p_period_start DATE, p_period_end DATE, p_payment_date DATE, p_notes TEXT)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  v_id    BIGINT;
  v_other RECORD;
BEGIN
  PERFORM payroll.ensure_settings(p_tenant);
  IF p_kind NOT IN ('ordinaria', 'aguinaldo') THEN RAISE EXCEPTION 'Tipo de planilla inválido' USING ERRCODE = '22023'; END IF;
  IF p_kind = 'aguinaldo' THEN p_frequency := 'mensual'; END IF;
  IF p_frequency NOT IN ('mensual', 'quincenal') THEN RAISE EXCEPTION 'Frecuencia inválida' USING ERRCODE = '22023'; END IF;
  IF p_period_start IS NULL OR p_period_end IS NULL OR p_payment_date IS NULL THEN
    RAISE EXCEPTION 'Indica el período y la fecha de pago' USING ERRCODE = '22023';
  END IF;
  IF p_period_end < p_period_start THEN
    RAISE EXCEPTION 'El fin del período debe ser posterior a su inicio' USING ERRCODE = '22023';
  END IF;
  SELECT payroll_number, status, period_start, period_end INTO v_other FROM payroll.payrolls
  WHERE tenant_id = p_tenant AND kind = p_kind AND frequency = p_frequency AND status <> 'anulada'
    AND period_start <= p_period_end AND period_end >= p_period_start
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Ya existe una planilla % (%) que cubre esas fechas: % al %',
      p_kind, v_other.status, to_char(v_other.period_start, 'DD/MM/YYYY'), to_char(v_other.period_end, 'DD/MM/YYYY')
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO payroll.payrolls (tenant_id, kind, frequency, period_start, period_end, payment_date, notes, created_by_name)
  VALUES (p_tenant, p_kind, p_frequency, p_period_start, p_period_end, p_payment_date, NULLIF(btrim(p_notes), ''), accounting.ctx_user_name())
  RETURNING id INTO v_id;
  PERFORM payroll.sync_lines(v_id);
  IF NOT EXISTS (SELECT 1 FROM payroll.payroll_lines WHERE payroll_id = v_id) THEN
    RAISE EXCEPTION 'No hay empleados activos con pago % en ese período', p_frequency USING ERRCODE = '22023';
  END IF;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION payroll.update_line(p_tenant BIGINT, p_line_id BIGINT, p_inputs JSONB)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  l     payroll.payroll_lines%ROWTYPE;
  v_num NUMERIC;
  k     TEXT;
BEGIN
  SELECT * INTO l FROM payroll.payroll_lines WHERE id = p_line_id AND tenant_id = p_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'Línea de planilla no encontrada' USING ERRCODE = 'P0002'; END IF;
  PERFORM payroll.assert_draft(p_tenant, l.payroll_id);
  FOREACH k IN ARRAY ARRAY['absence_days', 'overtime_day_hours', 'overtime_night_hours', 'holiday_days', 'bonuses', 'other_deductions'] LOOP
    IF p_inputs ? k THEN
      v_num := coalesce(NULLIF(p_inputs->>k, '')::NUMERIC, 0);
      IF v_num < 0 OR v_num > 99999 THEN RAISE EXCEPTION 'Valor inválido en %', k USING ERRCODE = '22023'; END IF;
    END IF;
  END LOOP;
  IF coalesce(NULLIF(p_inputs->>'absence_days', '')::NUMERIC, l.absence_days) > l.period_days THEN
    RAISE EXCEPTION 'Las faltas no pueden superar los % días del período', l.period_days USING ERRCODE = '22023';
  END IF;
  UPDATE payroll.payroll_lines SET
    absence_days         = CASE WHEN p_inputs ? 'absence_days' THEN coalesce(NULLIF(p_inputs->>'absence_days', '')::NUMERIC, 0) ELSE absence_days END,
    overtime_day_hours   = CASE WHEN p_inputs ? 'overtime_day_hours' THEN coalesce(NULLIF(p_inputs->>'overtime_day_hours', '')::NUMERIC, 0) ELSE overtime_day_hours END,
    overtime_night_hours = CASE WHEN p_inputs ? 'overtime_night_hours' THEN coalesce(NULLIF(p_inputs->>'overtime_night_hours', '')::NUMERIC, 0) ELSE overtime_night_hours END,
    holiday_days         = CASE WHEN p_inputs ? 'holiday_days' THEN coalesce(NULLIF(p_inputs->>'holiday_days', '')::NUMERIC, 0) ELSE holiday_days END,
    vacation             = CASE WHEN p_inputs ? 'vacation' THEN coalesce((p_inputs->>'vacation')::BOOLEAN, false) ELSE vacation END,
    bonuses              = CASE WHEN p_inputs ? 'bonuses' THEN round(coalesce(NULLIF(p_inputs->>'bonuses', '')::NUMERIC, 0), 2) ELSE bonuses END,
    bonuses_note         = CASE WHEN p_inputs ? 'bonuses_note' THEN NULLIF(btrim(p_inputs->>'bonuses_note'), '') ELSE bonuses_note END,
    other_deductions     = CASE WHEN p_inputs ? 'other_deductions' THEN round(coalesce(NULLIF(p_inputs->>'other_deductions', '')::NUMERIC, 0), 2) ELSE other_deductions END,
    deductions_note      = CASE WHEN p_inputs ? 'deductions_note' THEN NULLIF(btrim(p_inputs->>'deductions_note'), '') ELSE deductions_note END
  WHERE id = l.id;
  PERFORM payroll.compute_line(l.id);
  PERFORM payroll.refresh_totals(l.payroll_id);
END;
$$;

-- ── Cuentas de un centro de costo (o el rol general) ──
CREATE OR REPLACE FUNCTION payroll.cc_account(p_tenant BIGINT, p_cc BIGINT, p_kind TEXT)
RETURNS BIGINT LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT CASE p_kind WHEN 'salary' THEN salary_account_id WHEN 'isss' THEN isss_account_id ELSE afp_account_id END
       FROM payroll.cost_centers WHERE id = p_cc AND tenant_id = p_tenant),
    accounting.role_account(p_tenant, CASE p_kind WHEN 'salary' THEN 'payroll_salary' WHEN 'isss' THEN 'payroll_isss_employer' ELSE 'payroll_afp_employer' END))
$$;

/**
 * Asiento de planilla: Debe sueldos (por centro de costo; aguinaldo a
 * prestaciones) + aportes patronales / Haber sueldos por pagar (líquido),
 * ISSS y AFP por pagar (laboral + patronal), renta retenida, otros descuentos.
 */
CREATE OR REPLACE FUNCTION payroll.post_payroll(p_tenant BIGINT, p_payroll_id BIGINT)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  p       payroll.payrolls%ROWTYPE;
  v_ref   TEXT;
  v_lines JSONB := '[]';
  a       RECORD;
BEGIN
  SELECT * INTO p FROM payroll.payrolls WHERE id = p_payroll_id AND tenant_id = p_tenant;
  v_ref := 'Planilla PL-' || lpad(p.payroll_number::TEXT, 5, '0');
  FOR a IN
    SELECT l.cost_center_id, c.name AS cc, sum(l.gross - l.aguinaldo) salaries, sum(l.aguinaldo) aguinaldo,
           sum(l.isss_employer + l.insaforp) isss_r, sum(l.afp_employer) afp_r
    FROM payroll.payroll_lines l JOIN payroll.cost_centers c ON c.id = l.cost_center_id
    WHERE l.payroll_id = p.id GROUP BY l.cost_center_id, c.name ORDER BY c.name
  LOOP
    v_lines := v_lines
      || jsonb_build_object('account_id', CASE WHEN a.salaries <> 0 THEN payroll.cc_account(p_tenant, a.cost_center_id, 'salary') END,
                            'amount', a.salaries, 'description', 'Sueldos ' || a.cc, 'cost_center', a.cc, 'reference', v_ref)
      || jsonb_build_object('account_id', CASE WHEN a.aguinaldo <> 0 THEN accounting.role_account(p_tenant, 'payroll_benefits') END,
                            'amount', a.aguinaldo, 'description', 'Aguinaldo ' || a.cc, 'cost_center', a.cc, 'reference', v_ref)
      || jsonb_build_object('account_id', CASE WHEN a.isss_r <> 0 THEN payroll.cc_account(p_tenant, a.cost_center_id, 'isss') END,
                            'amount', a.isss_r, 'description', 'ISSS patronal ' || a.cc, 'cost_center', a.cc, 'reference', v_ref)
      || jsonb_build_object('account_id', CASE WHEN a.afp_r <> 0 THEN payroll.cc_account(p_tenant, a.cost_center_id, 'afp') END,
                            'amount', a.afp_r, 'description', 'AFP patronal ' || a.cc, 'cost_center', a.cc, 'reference', v_ref);
  END LOOP;
  v_lines := v_lines
    || jsonb_build_object('account_id', accounting.role_account(p_tenant, 'payroll_payable'), 'amount', -p.net,
                          'description', 'Líquido a pagar', 'reference', v_ref)
    || jsonb_build_object('account_id', CASE WHEN p.isss_employee + p.isss_employer + p.insaforp <> 0 THEN accounting.role_account(p_tenant, 'payroll_isss_payable') END,
                          'amount', -(p.isss_employee + p.isss_employer + p.insaforp), 'description', 'ISSS laboral y patronal', 'reference', v_ref)
    || jsonb_build_object('account_id', CASE WHEN p.afp_employee + p.afp_employer <> 0 THEN accounting.role_account(p_tenant, 'payroll_afp_payable') END,
                          'amount', -(p.afp_employee + p.afp_employer), 'description', 'AFP laboral y patronal', 'reference', v_ref)
    || jsonb_build_object('account_id', CASE WHEN p.isr <> 0 THEN accounting.role_account(p_tenant, 'income_tax_withheld') END,
                          'amount', -p.isr, 'description', 'Renta retenida', 'reference', v_ref)
    || jsonb_build_object('account_id', CASE WHEN p.other_deductions <> 0 THEN accounting.role_account(p_tenant, 'payroll_other_deductions') END,
                          'amount', -p.other_deductions, 'description', 'Otros descuentos', 'reference', v_ref);

  RETURN accounting.create_entry(p_tenant, p.period_end, 'PAYROLL', 'planilla', p.id::TEXT, v_ref,
    CASE p.kind WHEN 'aguinaldo' THEN 'Planilla de aguinaldo ' || extract(year FROM p.period_end)
      ELSE 'Planilla ' || p.frequency || ' del ' || to_char(p.period_start, 'DD/MM/YYYY') || ' al ' || to_char(p.period_end, 'DD/MM/YYYY') END,
    accounting.amount_lines(v_lines));
END;
$$;

CREATE OR REPLACE FUNCTION payroll.emit_payroll(p_tenant BIGINT, p_payroll_id BIGINT)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  p      payroll.payrolls%ROWTYPE;
  v_line BIGINT;
  v_n    BIGINT;
BEGIN
  p := payroll.assert_draft(p_tenant, p_payroll_id);
  IF NOT EXISTS (SELECT 1 FROM payroll.payroll_lines WHERE payroll_id = p.id) THEN
    RAISE EXCEPTION 'La planilla no tiene empleados' USING ERRCODE = '22023';
  END IF;
  FOR v_line IN SELECT id FROM payroll.payroll_lines WHERE payroll_id = p.id LOOP
    PERFORM payroll.compute_line(v_line);
  END LOOP;
  PERFORM payroll.refresh_totals(p.id);
  v_n := accounting.next_number(p_tenant, 'payroll');
  UPDATE payroll.payrolls SET status = 'emitida', payroll_number = v_n, emitted_at = NOW(), emitted_by_name = accounting.ctx_user_name()
  WHERE id = p.id;
  UPDATE payroll.payrolls SET journal_entry_id = payroll.post_payroll(p_tenant, p.id) WHERE id = p.id;
  RETURN v_n;
END;
$$;

/** Pago de la planilla: Debe sueldos por pagar / Haber banco o caja (conciliable en Bancos). */
CREATE OR REPLACE FUNCTION payroll.pay_payroll(p_tenant BIGINT, p_payroll_id BIGINT, p_date DATE, p_fund_account BIGINT)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  p payroll.payrolls%ROWTYPE;
  v_entry BIGINT;
BEGIN
  SELECT * INTO p FROM payroll.payrolls WHERE id = p_payroll_id AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Planilla no encontrada' USING ERRCODE = 'P0002'; END IF;
  IF p.status <> 'emitida' THEN RAISE EXCEPTION 'Solo se pagan planillas emitidas' USING ERRCODE = '22023'; END IF;
  IF p.paid_entry_id IS NOT NULL THEN RAISE EXCEPTION 'La planilla ya está pagada' USING ERRCODE = '22023'; END IF;
  v_entry := accounting.create_entry(p_tenant, p_date, 'PAYROLL_PAID', 'planilla', p.id::TEXT,
    'Planilla PL-' || lpad(p.payroll_number::TEXT, 5, '0'), 'Pago de planilla PL-' || lpad(p.payroll_number::TEXT, 5, '0'),
    accounting.amount_lines(jsonb_build_array(
      jsonb_build_object('account_id', accounting.role_account(p_tenant, 'payroll_payable'), 'amount', p.net, 'description', 'Pago de sueldos'),
      jsonb_build_object('account_id', p_fund_account, 'amount', -p.net, 'description', 'Pago de planilla'))));
  UPDATE payroll.payrolls SET paid_entry_id = v_entry, paid_at = p_date WHERE id = p.id;
  RETURN v_entry;
END;
$$;

CREATE OR REPLACE FUNCTION payroll.void_payroll(p_tenant BIGINT, p_payroll_id BIGINT, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  p payroll.payrolls%ROWTYPE;
BEGIN
  SELECT * INTO p FROM payroll.payrolls WHERE id = p_payroll_id AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Planilla no encontrada' USING ERRCODE = 'P0002'; END IF;
  IF p.status <> 'emitida' THEN RAISE EXCEPTION 'Solo se anulan planillas emitidas' USING ERRCODE = '22023'; END IF;
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'Indica el motivo de la anulación' USING ERRCODE = '22023'; END IF;
  IF p.paid_entry_id IS NOT NULL THEN
    PERFORM accounting.reverse_entry(p_tenant, p.paid_entry_id, 'Planilla anulada: ' || btrim(p_reason), 'PAYROLL_PAID_VOID');
  END IF;
  IF p.journal_entry_id IS NOT NULL THEN
    PERFORM accounting.reverse_entry(p_tenant, p.journal_entry_id, 'Planilla anulada: ' || btrim(p_reason), 'PAYROLL_VOID');
  END IF;
  UPDATE payroll.payrolls SET status = 'anulada', voided_at = NOW(), voided_by_name = accounting.ctx_user_name(), void_reason = btrim(p_reason)
  WHERE id = p.id;
END;
$$;

-- =============================================================================
-- LIQUIDACIONES (despido / renuncia)
-- =============================================================================
CREATE TABLE payroll.terminations (
  id                 BIGSERIAL PRIMARY KEY,
  tenant_id          BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  termination_number BIGINT NOT NULL,
  employee_id        BIGINT NOT NULL REFERENCES payroll.employees(id),
  employee_name      TEXT NOT NULL,
  dui                TEXT,
  position           TEXT,
  cost_center_id     BIGINT NOT NULL REFERENCES payroll.cost_centers(id),
  hire_date          DATE NOT NULL,
  monthly_salary     NUMERIC(10,2) NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('despido_injustificado', 'despido_justificado', 'renuncia')),
  termination_date   DATE NOT NULL,
  paid_through       DATE NOT NULL,
  reason             TEXT,
  service_days       INT NOT NULL,
  pending_salary     NUMERIC(10,2) NOT NULL DEFAULT 0,
  vacation           NUMERIC(10,2) NOT NULL DEFAULT 0,
  aguinaldo          NUMERIC(10,2) NOT NULL DEFAULT 0,
  indemnity          NUMERIC(10,2) NOT NULL DEFAULT 0,
  other_income       NUMERIC(10,2) NOT NULL DEFAULT 0,
  gross              NUMERIC(10,2) NOT NULL DEFAULT 0,
  isss_employee      NUMERIC(10,2) NOT NULL DEFAULT 0,
  afp_employee       NUMERIC(10,2) NOT NULL DEFAULT 0,
  isr                NUMERIC(10,2) NOT NULL DEFAULT 0,
  other_deductions   NUMERIC(10,2) NOT NULL DEFAULT 0,
  net                NUMERIC(10,2) NOT NULL DEFAULT 0,
  isss_employer      NUMERIC(10,2) NOT NULL DEFAULT 0,
  afp_employer       NUMERIC(10,2) NOT NULL DEFAULT 0,
  detail             JSONB NOT NULL,
  status             TEXT NOT NULL DEFAULT 'registrada' CHECK (status IN ('registrada', 'anulada')),
  journal_entry_id   BIGINT REFERENCES accounting.journal_entries(id),
  paid_entry_id      BIGINT REFERENCES accounting.journal_entries(id),
  created_by_name    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  voided_at          TIMESTAMPTZ,
  voided_by_name     TEXT,
  void_reason        TEXT,
  UNIQUE (tenant_id, termination_number)
);
CREATE INDEX idx_terminations_employee ON payroll.terminations(employee_id);

/** Último día pagado por una planilla ordinaria emitida (o el día anterior al ingreso). */
CREATE OR REPLACE FUNCTION payroll.employee_paid_through(p_employee_id BIGINT)
RETURNS DATE LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT max(p.period_end) FROM payroll.payroll_lines l JOIN payroll.payrolls p ON p.id = l.payroll_id
     WHERE l.employee_id = p_employee_id AND p.kind = 'ordinaria' AND p.status = 'emitida'),
    (SELECT hire_date - 1 FROM payroll.employees WHERE id = p_employee_id))
$$;

/**
 * Liquidación de un empleado a una fecha, sin guardar nada.
 * p_options: {paid_through, include_vacation (true), pending_vacation_periods (0),
 *             include_aguinaldo (true), other_income (0), other_deductions (0)}
 */
CREATE OR REPLACE FUNCTION payroll.compute_termination(p_tenant BIGINT, p_employee_id BIGINT, p_kind TEXT, p_date DATE, p_options JSONB)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  e            payroll.employees%ROWTYPE;
  s            payroll.settings%ROWTYPE;
  o            JSONB := coalesce(p_options, '{}');
  v_daily      NUMERIC;
  v_service    INT;
  v_years      INT;
  v_paid       DATE;
  v_pending_d  INT;
  v_pending    NUMERIC := 0;
  v_anniv      DATE;
  v_vac_days   INT := 0;
  v_vac_prop   NUMERIC := 0;
  v_vac_periods INT;
  v_vac_pend   NUMERIC := 0;
  v_ag_start   DATE;
  v_ag_days    NUMERIC := 0;
  v_ag_period  INT := 0;
  v_aguinaldo  NUMERIC := 0;
  v_ind_base   NUMERIC := 0;
  v_indemnity  NUMERIC := 0;
  v_ind_note   TEXT;
  v_other_in   NUMERIC := round(coalesce(NULLIF(o->>'other_income', '')::NUMERIC, 0), 2);
  v_other_ded  NUMERIC := round(coalesce(NULLIF(o->>'other_deductions', '')::NUMERIC, 0), 2);
  v_cot        NUMERIC;
  v_isss_e     NUMERIC := 0;
  v_isss_r     NUMERIC := 0;
  v_afp_e      NUMERIC := 0;
  v_afp_r      NUMERIC := 0;
  v_isr_base   NUMERIC;
  v_isr        NUMERIC := 0;
  v_gross      NUMERIC;
BEGIN
  SELECT * INTO e FROM payroll.employees WHERE id = p_employee_id AND tenant_id = p_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'Empleado no encontrado' USING ERRCODE = 'P0002'; END IF;
  PERFORM payroll.ensure_settings(p_tenant);
  SELECT * INTO s FROM payroll.settings WHERE tenant_id = p_tenant;
  IF p_kind NOT IN ('despido_injustificado', 'despido_justificado', 'renuncia') THEN
    RAISE EXCEPTION 'Tipo de retiro inválido' USING ERRCODE = '22023';
  END IF;
  IF p_date IS NULL OR p_date < e.hire_date THEN
    RAISE EXCEPTION 'La fecha de retiro debe ser posterior al ingreso (%)', to_char(e.hire_date, 'DD/MM/YYYY') USING ERRCODE = '22023';
  END IF;
  IF v_other_in < 0 OR v_other_ded < 0 THEN RAISE EXCEPTION 'Los montos no pueden ser negativos' USING ERRCODE = '22023'; END IF;

  v_daily   := e.monthly_salary / 30;
  v_service := p_date - e.hire_date + 1;
  v_years   := extract(year FROM age(p_date + 1, e.hire_date))::INT;

  v_paid := coalesce(NULLIF(o->>'paid_through', '')::DATE, payroll.employee_paid_through(e.id));
  v_paid := greatest(v_paid, e.hire_date - 1);
  v_pending_d := payroll.commercial_days(v_paid + 1, p_date);
  v_pending := round(v_daily * v_pending_d, 2);

  IF coalesce((o->>'include_vacation')::BOOLEAN, true) THEN
    v_anniv := (e.hire_date + make_interval(years => v_years))::DATE;
    v_vac_days := greatest(p_date - v_anniv + 1, 0);
    v_vac_prop := round(15 * v_daily * (1 + s.vacation_premium) * v_vac_days / 365.0, 2);
  END IF;
  v_vac_periods := greatest(coalesce(NULLIF(o->>'pending_vacation_periods', '')::INT, 0), 0);
  v_vac_pend := round(v_vac_periods * 15 * v_daily * (1 + s.vacation_premium), 2);

  IF coalesce((o->>'include_aguinaldo')::BOOLEAN, true) THEN
    v_ag_start := make_date(extract(year FROM p_date)::INT, 12, 13);
    IF v_ag_start > p_date THEN v_ag_start := (v_ag_start - INTERVAL '1 year')::DATE; END IF;
    v_ag_start := greatest(v_ag_start, e.hire_date);
    v_ag_period := p_date - v_ag_start + 1;
    v_ag_days := CASE WHEN v_years < 3 THEN 15 WHEN v_years < 10 THEN 19 ELSE 21 END;
    v_aguinaldo := round(v_daily * v_ag_days * v_ag_period / 365.0, 2);
  END IF;

  IF p_kind = 'despido_injustificado' THEN
    v_ind_base := least(e.monthly_salary, 4 * s.minimum_wage);
    v_indemnity := greatest(round(v_ind_base * v_service / 365.0, 2), round(15 * v_daily, 2));
    v_ind_note := 'Art. 58 CT: 30 días de salario por año de servicio (proporcional), salario tope de 4 salarios mínimos ($'
      || to_char(4 * s.minimum_wage, 'FM999990.00') || '); mínimo 15 días de salario';
  ELSIF p_kind = 'renuncia' THEN
    IF v_service >= 730 THEN
      v_ind_base := least(e.monthly_salary, 2 * s.minimum_wage);
      v_indemnity := round(v_ind_base / 2 * v_service / 365.0, 2);
      v_ind_note := 'Prestación por renuncia voluntaria: 15 días de salario por año de servicio (proporcional), salario tope de 2 salarios mínimos ($'
        || to_char(2 * s.minimum_wage, 'FM999990.00') || ')';
    ELSE
      v_ind_note := 'Sin prestación por renuncia: requiere 2 años de servicio';
    END IF;
  ELSE
    v_ind_note := 'Despido con causa justificada: sin indemnización';
  END IF;

  v_cot := v_pending + v_vac_prop + v_vac_pend + v_other_in;
  IF e.applies_isss THEN
    v_isss_e := round(least(v_cot, s.isss_cap) * s.isss_employee_rate, 2);
    v_isss_r := round(least(v_cot, s.isss_cap) * s.isss_employer_rate, 2);
  END IF;
  IF e.applies_afp THEN
    v_afp_e := round(CASE WHEN s.afp_cap IS NULL THEN v_cot ELSE least(v_cot, s.afp_cap) END * s.afp_employee_rate, 2);
    v_afp_r := round(CASE WHEN s.afp_cap IS NULL THEN v_cot ELSE least(v_cot, s.afp_cap) END * s.afp_employer_rate, 2);
  END IF;
  v_isr_base := greatest(v_cot - v_isss_e - v_afp_e + greatest(v_aguinaldo - s.aguinaldo_exempt, 0), 0);
  IF e.applies_isr THEN v_isr := payroll.isr_retention(p_tenant, 'mensual', v_isr_base); END IF;

  v_gross := v_pending + v_vac_prop + v_vac_pend + v_aguinaldo + v_indemnity + v_other_in;
  RETURN jsonb_build_object(
    'employee_id', e.id, 'employee_name', e.full_name, 'dui', e.dui, 'position', e.position, 'cost_center_id', e.cost_center_id,
    'hire_date', e.hire_date, 'monthly_salary', e.monthly_salary, 'daily_salary', round(v_daily, 4),
    'kind', p_kind, 'termination_date', p_date, 'service_days', v_service, 'service_years', v_years,
    'service_text', v_years || ' año(s) y ' || (p_date - (e.hire_date + make_interval(years => v_years))::DATE + 1) || ' día(s)',
    'paid_through', v_paid, 'pending_days', v_pending_d, 'pending_salary', v_pending,
    'vacation_days', v_vac_days, 'vacation_proportional', v_vac_prop,
    'pending_vacation_periods', v_vac_periods, 'vacation_pending', v_vac_pend, 'vacation', v_vac_prop + v_vac_pend,
    'aguinaldo_days', v_ag_days, 'aguinaldo_period_days', v_ag_period, 'aguinaldo', v_aguinaldo,
    'indemnity_base_salary', v_ind_base, 'indemnity', v_indemnity, 'indemnity_note', v_ind_note,
    'other_income', v_other_in, 'gross', v_gross,
    'isss_employee', v_isss_e, 'afp_employee', v_afp_e, 'isr_base', v_isr_base, 'isr', v_isr,
    'other_deductions', v_other_ded, 'total_deductions', v_isss_e + v_afp_e + v_isr + v_other_ded,
    'net', v_gross - v_isss_e - v_afp_e - v_isr - v_other_ded,
    'isss_employer', v_isss_r, 'afp_employer', v_afp_r,
    'minimum_wage', s.minimum_wage);
END;
$$;

CREATE OR REPLACE FUNCTION payroll.post_termination(p_tenant BIGINT, p_id BIGINT)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  t     payroll.terminations%ROWTYPE;
  v_ref TEXT;
  v_cc  TEXT;
BEGIN
  SELECT * INTO t FROM payroll.terminations WHERE id = p_id AND tenant_id = p_tenant;
  SELECT name INTO v_cc FROM payroll.cost_centers WHERE id = t.cost_center_id;
  v_ref := 'Liquidación LQ-' || lpad(t.termination_number::TEXT, 5, '0');
  RETURN accounting.create_entry(p_tenant, t.termination_date, 'TERMINATION', 'planilla', 'LQ-' || t.id, v_ref,
    'Liquidación de ' || t.employee_name,
    accounting.amount_lines(jsonb_build_array(
      jsonb_build_object('account_id', CASE WHEN t.pending_salary + t.other_income <> 0 THEN payroll.cc_account(p_tenant, t.cost_center_id, 'salary') END,
                         'amount', t.pending_salary + t.other_income, 'description', 'Salario pendiente', 'cost_center', v_cc, 'reference', v_ref),
      jsonb_build_object('account_id', CASE WHEN t.vacation + t.aguinaldo + t.indemnity <> 0 THEN accounting.role_account(p_tenant, 'payroll_benefits') END,
                         'amount', t.vacation + t.aguinaldo + t.indemnity, 'description', 'Vacaciones, aguinaldo e indemnización', 'cost_center', v_cc, 'reference', v_ref),
      jsonb_build_object('account_id', CASE WHEN t.isss_employer <> 0 THEN payroll.cc_account(p_tenant, t.cost_center_id, 'isss') END,
                         'amount', t.isss_employer, 'description', 'ISSS patronal', 'cost_center', v_cc, 'reference', v_ref),
      jsonb_build_object('account_id', CASE WHEN t.afp_employer <> 0 THEN payroll.cc_account(p_tenant, t.cost_center_id, 'afp') END,
                         'amount', t.afp_employer, 'description', 'AFP patronal', 'cost_center', v_cc, 'reference', v_ref),
      jsonb_build_object('account_id', accounting.role_account(p_tenant, 'payroll_payable'), 'amount', -t.net,
                         'description', 'Líquido a pagar a ' || t.employee_name, 'reference', v_ref),
      jsonb_build_object('account_id', CASE WHEN t.isss_employee + t.isss_employer <> 0 THEN accounting.role_account(p_tenant, 'payroll_isss_payable') END,
                         'amount', -(t.isss_employee + t.isss_employer), 'description', 'ISSS laboral y patronal', 'reference', v_ref),
      jsonb_build_object('account_id', CASE WHEN t.afp_employee + t.afp_employer <> 0 THEN accounting.role_account(p_tenant, 'payroll_afp_payable') END,
                         'amount', -(t.afp_employee + t.afp_employer), 'description', 'AFP laboral y patronal', 'reference', v_ref),
      jsonb_build_object('account_id', CASE WHEN t.isr <> 0 THEN accounting.role_account(p_tenant, 'income_tax_withheld') END,
                         'amount', -t.isr, 'description', 'Renta retenida', 'reference', v_ref),
      jsonb_build_object('account_id', CASE WHEN t.other_deductions <> 0 THEN accounting.role_account(p_tenant, 'payroll_other_deductions') END,
                         'amount', -t.other_deductions, 'description', 'Otros descuentos', 'reference', v_ref))));
END;
$$;

CREATE OR REPLACE FUNCTION payroll.register_termination(p_tenant BIGINT, p_employee_id BIGINT, p_kind TEXT, p_date DATE, p_options JSONB, p_reason TEXT)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  e    payroll.employees%ROWTYPE;
  d    JSONB;
  v_id BIGINT;
  v_n  BIGINT;
BEGIN
  SELECT * INTO e FROM payroll.employees WHERE id = p_employee_id AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Empleado no encontrado' USING ERRCODE = 'P0002'; END IF;
  IF e.status = 'retirado' THEN
    RAISE EXCEPTION '% ya está retirado desde el %', e.full_name, to_char(e.termination_date, 'DD/MM/YYYY') USING ERRCODE = '22023';
  END IF;
  IF p_kind = 'despido_justificado' AND coalesce(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'Indica la causa del despido' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM payroll.payroll_lines l JOIN payroll.payrolls p ON p.id = l.payroll_id
             WHERE l.employee_id = e.id AND p.kind = 'ordinaria' AND p.status = 'emitida' AND p.period_start > p_date) THEN
    RAISE EXCEPTION 'Hay una planilla emitida para % con un período posterior al retiro; anúlala primero', e.full_name USING ERRCODE = '22023';
  END IF;

  d := payroll.compute_termination(p_tenant, e.id, p_kind, p_date, p_options);
  v_n := accounting.next_number(p_tenant, 'termination');
  INSERT INTO payroll.terminations (tenant_id, termination_number, employee_id, employee_name, dui, position, cost_center_id,
    hire_date, monthly_salary, kind, termination_date, paid_through, reason, service_days, pending_salary, vacation,
    aguinaldo, indemnity, other_income, gross, isss_employee, afp_employee, isr, other_deductions, net, isss_employer,
    afp_employer, detail, created_by_name)
  VALUES (p_tenant, v_n, e.id, e.full_name, e.dui, e.position, e.cost_center_id, e.hire_date, e.monthly_salary, p_kind, p_date,
    (d->>'paid_through')::DATE, NULLIF(btrim(p_reason), ''), (d->>'service_days')::INT, (d->>'pending_salary')::NUMERIC,
    (d->>'vacation')::NUMERIC, (d->>'aguinaldo')::NUMERIC, (d->>'indemnity')::NUMERIC, (d->>'other_income')::NUMERIC,
    (d->>'gross')::NUMERIC, (d->>'isss_employee')::NUMERIC, (d->>'afp_employee')::NUMERIC, (d->>'isr')::NUMERIC,
    (d->>'other_deductions')::NUMERIC, (d->>'net')::NUMERIC, (d->>'isss_employer')::NUMERIC, (d->>'afp_employer')::NUMERIC,
    d, accounting.ctx_user_name())
  RETURNING id INTO v_id;

  UPDATE payroll.employees SET status = 'retirado', termination_date = p_date, updated_at = NOW() WHERE id = e.id;
  UPDATE payroll.terminations SET journal_entry_id = payroll.post_termination(p_tenant, v_id) WHERE id = v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION payroll.pay_termination(p_tenant BIGINT, p_id BIGINT, p_date DATE, p_fund_account BIGINT)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  t payroll.terminations%ROWTYPE;
  v_entry BIGINT;
BEGIN
  SELECT * INTO t FROM payroll.terminations WHERE id = p_id AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Liquidación no encontrada' USING ERRCODE = 'P0002'; END IF;
  IF t.status <> 'registrada' THEN RAISE EXCEPTION 'La liquidación está anulada' USING ERRCODE = '22023'; END IF;
  IF t.paid_entry_id IS NOT NULL THEN RAISE EXCEPTION 'La liquidación ya está pagada' USING ERRCODE = '22023'; END IF;
  v_entry := accounting.create_entry(p_tenant, p_date, 'TERMINATION_PAID', 'planilla', 'LQ-' || t.id,
    'Liquidación LQ-' || lpad(t.termination_number::TEXT, 5, '0'), 'Pago de liquidación a ' || t.employee_name,
    accounting.amount_lines(jsonb_build_array(
      jsonb_build_object('account_id', accounting.role_account(p_tenant, 'payroll_payable'), 'amount', t.net, 'description', t.employee_name),
      jsonb_build_object('account_id', p_fund_account, 'amount', -t.net, 'description', 'Pago de liquidación'))));
  UPDATE payroll.terminations SET paid_entry_id = v_entry WHERE id = t.id;
  RETURN v_entry;
END;
$$;

CREATE OR REPLACE FUNCTION payroll.void_termination(p_tenant BIGINT, p_id BIGINT, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  t payroll.terminations%ROWTYPE;
BEGIN
  SELECT * INTO t FROM payroll.terminations WHERE id = p_id AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Liquidación no encontrada' USING ERRCODE = 'P0002'; END IF;
  IF t.status <> 'registrada' THEN RAISE EXCEPTION 'La liquidación ya está anulada' USING ERRCODE = '22023'; END IF;
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'Indica el motivo de la anulación' USING ERRCODE = '22023'; END IF;
  IF t.paid_entry_id IS NOT NULL THEN
    PERFORM accounting.reverse_entry(p_tenant, t.paid_entry_id, 'Liquidación anulada: ' || btrim(p_reason), 'TERMINATION_PAID_VOID');
  END IF;
  IF t.journal_entry_id IS NOT NULL THEN
    PERFORM accounting.reverse_entry(p_tenant, t.journal_entry_id, 'Liquidación anulada: ' || btrim(p_reason), 'TERMINATION_VOID');
  END IF;
  UPDATE payroll.terminations SET status = 'anulada', voided_at = NOW(), voided_by_name = accounting.ctx_user_name(), void_reason = btrim(p_reason)
  WHERE id = t.id;
  UPDATE payroll.employees SET status = 'activo', termination_date = NULL, updated_at = NOW() WHERE id = t.employee_id;
END;
$$;

CREATE OR REPLACE FUNCTION payroll.save_isr_brackets(p_tenant BIGINT, p_frequency TEXT, p_rows JSONB)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  r      JSONB;
  v_i    INT := 0;
  v_prev NUMERIC := -1;
BEGIN
  IF p_frequency NOT IN ('mensual', 'quincenal') THEN RAISE EXCEPTION 'Frecuencia inválida' USING ERRCODE = '22023'; END IF;
  IF p_rows IS NULL OR jsonb_array_length(p_rows) = 0 THEN RAISE EXCEPTION 'La tabla necesita al menos un tramo' USING ERRCODE = '22023'; END IF;
  DELETE FROM payroll.isr_brackets WHERE tenant_id = p_tenant AND frequency = p_frequency;
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_i := v_i + 1;
    IF (r->>'lower_limit')::NUMERIC <= v_prev THEN
      RAISE EXCEPTION 'Los tramos deben ir en orden ascendente (tramo %)', v_i USING ERRCODE = '22023';
    END IF;
    v_prev := (r->>'lower_limit')::NUMERIC;
    INSERT INTO payroll.isr_brackets (tenant_id, frequency, tramo, lower_limit, rate, excess_over, fixed_fee)
    VALUES (p_tenant, p_frequency, v_i, (r->>'lower_limit')::NUMERIC, (r->>'rate')::NUMERIC,
            coalesce((r->>'excess_over')::NUMERIC, 0), coalesce((r->>'fixed_fee')::NUMERIC, 0));
  END LOOP;
END;
$$;
