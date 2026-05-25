import { query, withTx } from '../db/client.js';
import { CorrelativoNotSeededError } from '../errors.js';
import type { CorrelativoRow } from './tenant.types.js';

/**
 * Correlativos atómicos respaldados por Postgres. Reemplaza el mutex
 * in-process por `SELECT … FOR UPDATE` dentro de una transacción — esto
 * desbloquea horizontal scaling (varias instancias del dte-service detrás
 * de un load balancer sin riesgo de race).
 *
 * Reglas fiscales que se mantienen idénticas al storage filesystem:
 *   - reservar solo permitido si `seeded = true`
 *   - reservar incrementa `reservados`, NO toca `ultimo_consumido`
 *   - consumir sube `ultimo_consumido` y quita el N de `reservados`
 *   - devolver libera la reservación (queda como gap, MH tolera)
 *   - sembrar idempotente (solo sube `ultimo_consumido`, nunca baja)
 */

type TipoDte = '01' | '03' | '05' | '14';

interface CorrelativoDbRow {
  tenant_id: number | string;       // pg devuelve bigint como string
  tipo_dte: TipoDte;
  seeded: boolean;
  seeded_at: string | null;
  seeded_by: string | null;
  ultimo_consumido: string | number;
  reservados: number[] | string[];
  updated_at: string;
}

function rowToCorrelativo(r: CorrelativoDbRow): CorrelativoRow {
  return {
    tenant_id: Number(r.tenant_id),
    tipo_dte: r.tipo_dte,
    seeded: r.seeded,
    seeded_at: r.seeded_at,
    seeded_by: r.seeded_by,
    ultimo_consumido: Number(r.ultimo_consumido),
    reservados: (r.reservados ?? []).map(n => Number(n)),
    updated_at: r.updated_at,
  };
}

/** Lectura no bloqueante. Devuelve un placeholder seeded=false si no existe. */
export async function peek(tenantId: number, tipoDte: TipoDte): Promise<CorrelativoRow> {
  const res = await query<CorrelativoDbRow>(
    `SELECT tenant_id, tipo_dte, seeded, seeded_at, seeded_by,
            ultimo_consumido, reservados, updated_at
       FROM tenant_correlativos
      WHERE tenant_id = $1 AND tipo_dte = $2`,
    [tenantId, tipoDte],
  );
  const row = res.rows[0];
  if (row) return rowToCorrelativo(row);
  return {
    tenant_id: tenantId,
    tipo_dte: tipoDte,
    seeded: false,
    seeded_at: null,
    seeded_by: null,
    ultimo_consumido: 0,
    reservados: [],
    updated_at: new Date(0).toISOString(),
  };
}

export async function listAll(tenantId: number): Promise<CorrelativoRow[]> {
  const res = await query<CorrelativoDbRow>(
    `SELECT * FROM tenant_correlativos WHERE tenant_id = $1 ORDER BY tipo_dte`,
    [tenantId],
  );
  // Asegurar 4 tipos, completando con placeholders los que no existan.
  const TIPOS: TipoDte[] = ['01', '03', '05', '14'];
  const byTipo = new Map(res.rows.map(r => [r.tipo_dte, rowToCorrelativo(r)]));
  return TIPOS.map(t => byTipo.get(t) ?? {
    tenant_id: tenantId, tipo_dte: t,
    seeded: false, seeded_at: null, seeded_by: null,
    ultimo_consumido: 0, reservados: [],
    updated_at: new Date(0).toISOString(),
  });
}

/**
 * Reserva atómica. SELECT FOR UPDATE serializa requests concurrentes contra
 * la misma fila. Throws CorrelativoNotSeededError si no está sembrado.
 */
export async function reservar(tenantId: number, tipoDte: TipoDte): Promise<number> {
  return withTx(async (client) => {
    const lockRes = await client.query<CorrelativoDbRow>(
      `SELECT * FROM tenant_correlativos
        WHERE tenant_id = $1 AND tipo_dte = $2
        FOR UPDATE`,
      [tenantId, tipoDte],
    );
    const cur = lockRes.rows[0];
    if (!cur || !cur.seeded) {
      throw new CorrelativoNotSeededError(tipoDte);
    }
    const reservadosArr = (cur.reservados ?? []).map(n => Number(n));
    const ultimo = Number(cur.ultimo_consumido);
    const maxRes = reservadosArr.length > 0 ? Math.max(...reservadosArr) : 0;
    const next = Math.max(ultimo, maxRes) + 1;
    await client.query(
      `UPDATE tenant_correlativos
          SET reservados = array_append(reservados, $3::BIGINT),
              updated_at = NOW()
        WHERE tenant_id = $1 AND tipo_dte = $2`,
      [tenantId, tipoDte, next],
    );
    return next;
  });
}

/** Commit del consumo: sube ultimo_consumido + remueve del array reservados. */
export async function consumir(tenantId: number, tipoDte: TipoDte, consecutivo: number): Promise<CorrelativoRow> {
  return withTx(async (client) => {
    const lockRes = await client.query<CorrelativoDbRow>(
      `SELECT * FROM tenant_correlativos
        WHERE tenant_id = $1 AND tipo_dte = $2 FOR UPDATE`,
      [tenantId, tipoDte],
    );
    const cur = lockRes.rows[0];
    if (!cur) {
      // Caso defensivo: alguien consumió sin reservar. Creamos la fila con
      // ultimo_consumido = consecutivo y seeded=true (efectivamente seed implícito).
      const ins = await client.query<CorrelativoDbRow>(
        `INSERT INTO tenant_correlativos
           (tenant_id, tipo_dte, seeded, seeded_at, seeded_by, ultimo_consumido, reservados)
         VALUES ($1, $2, TRUE, NOW(), 'implicit-consume', $3, ARRAY[]::BIGINT[])
         RETURNING *`,
        [tenantId, tipoDte, consecutivo],
      );
      return rowToCorrelativo(ins.rows[0]!);
    }
    const ultimo = Math.max(Number(cur.ultimo_consumido), consecutivo);
    const upd = await client.query<CorrelativoDbRow>(
      `UPDATE tenant_correlativos
          SET ultimo_consumido = $3,
              reservados = array_remove(reservados, $4::BIGINT),
              updated_at = NOW()
        WHERE tenant_id = $1 AND tipo_dte = $2
        RETURNING *`,
      [tenantId, tipoDte, ultimo, consecutivo],
    );
    return rowToCorrelativo(upd.rows[0]!);
  });
}

/** Release sin consumir — N queda como gap. */
export async function devolver(tenantId: number, tipoDte: TipoDte, consecutivo: number): Promise<CorrelativoRow> {
  return withTx(async (client) => {
    const upd = await client.query<CorrelativoDbRow>(
      `UPDATE tenant_correlativos
          SET reservados = array_remove(reservados, $3::BIGINT),
              updated_at = NOW()
        WHERE tenant_id = $1 AND tipo_dte = $2
        RETURNING *`,
      [tenantId, tipoDte, consecutivo],
    );
    const row = upd.rows[0];
    if (!row) return peek(tenantId, tipoDte);
    return rowToCorrelativo(row);
  });
}

/**
 * Seed administrativo: marca seeded=true y sube ultimo_consumido (nunca baja).
 * `seeded_at` y `seeded_by` se preservan del primer seed.
 */
export async function sembrar(
  tenantId: number,
  tipoDte: TipoDte,
  ultimoConsumido: number,
  seededBy: string | null = null,
): Promise<CorrelativoRow> {
  return withTx(async (client) => {
    const lockRes = await client.query<CorrelativoDbRow>(
      `SELECT * FROM tenant_correlativos
        WHERE tenant_id = $1 AND tipo_dte = $2 FOR UPDATE`,
      [tenantId, tipoDte],
    );
    const cur = lockRes.rows[0];
    if (!cur) {
      const ins = await client.query<CorrelativoDbRow>(
        `INSERT INTO tenant_correlativos
           (tenant_id, tipo_dte, seeded, seeded_at, seeded_by, ultimo_consumido, reservados)
         VALUES ($1, $2, TRUE, NOW(), $4, $3, ARRAY[]::BIGINT[])
         RETURNING *`,
        [tenantId, tipoDte, ultimoConsumido, seededBy],
      );
      return rowToCorrelativo(ins.rows[0]!);
    }
    const nuevoUltimo = Math.max(Number(cur.ultimo_consumido), ultimoConsumido);
    const upd = await client.query<CorrelativoDbRow>(
      `UPDATE tenant_correlativos
          SET seeded = TRUE,
              seeded_at = COALESCE(seeded_at, NOW()),
              seeded_by = COALESCE(seeded_by, $4),
              ultimo_consumido = $3,
              reservados = (SELECT COALESCE(array_agg(r), ARRAY[]::BIGINT[])
                              FROM unnest(reservados) AS r WHERE r > $3),
              updated_at = NOW()
        WHERE tenant_id = $1 AND tipo_dte = $2
        RETURNING *`,
      [tenantId, tipoDte, nuevoUltimo, seededBy],
    );
    return rowToCorrelativo(upd.rows[0]!);
  });
}
