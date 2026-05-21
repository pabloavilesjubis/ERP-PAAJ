import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { ValidationError } from '../errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = resolve(__dirname, '../../schemas');

const SCHEMA_FILES = {
  fcf: 'fe-fc-v1.json',
  ccf: 'fe-ccf-v3.json',
  nc: 'fe-nc-v3.json',
  fse: 'fe-fse-v1.json',
  anulacion: 'anulacion-schema-v2.json',
  contingencia: 'contingencia-schema-v3.json',
} as const;

export type SchemaKey = keyof typeof SCHEMA_FILES;

// Compilar todos los validators una vez al cargar el módulo. Validar es ~100x
// más rápido que compilar; no queremos pagar el costo en cada /emit.
const ajv = new Ajv({
  allErrors: true,           // reporta TODOS los errores, no sólo el primero
  strict: false,             // los schemas del MH usan formats no estándar (ej. integer mín/máx)
  allowUnionTypes: true,
});
addFormats(ajv);

const validators: Record<SchemaKey, ValidateFunction> = {} as Record<SchemaKey, ValidateFunction>;

for (const [key, file] of Object.entries(SCHEMA_FILES) as Array<[SchemaKey, string]>) {
  const path = resolve(SCHEMAS_DIR, file);
  const schema = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  validators[key] = ajv.compile(schema);
}

export interface ValidationFailure {
  path: string;
  keyword: string;
  message: string;
  params: Record<string, unknown>;
}

/**
 * Valida un DTE contra el schema oficial del MH. Lanza `ValidationError` con
 * la lista completa de errores si no pasa. Diseñado para invocarse antes de
 * firmar, así detectamos shape inválido en local en vez de gastar una llamada
 * al firmador y otra al MH para descubrir lo mismo.
 */
export function validateAgainstSchema(key: SchemaKey, payload: unknown): void {
  const validator = validators[key];
  const ok = validator(payload);
  if (!ok) {
    const failures = (validator.errors ?? []).map(toFailure);
    throw new ValidationError(
      `El DTE no cumple el schema oficial (${key}, ${failures.length} errores)`,
      { schema: key, failures },
    );
  }
}

function toFailure(err: ErrorObject): ValidationFailure {
  return {
    path: err.instancePath || '/',
    keyword: err.keyword,
    message: err.message ?? 'unknown',
    params: err.params as Record<string, unknown>,
  };
}

/** Acceso al validator crudo — útil para tests o validación manual. */
export function getValidator(key: SchemaKey): ValidateFunction {
  return validators[key];
}
