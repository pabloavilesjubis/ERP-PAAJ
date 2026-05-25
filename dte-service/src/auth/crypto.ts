import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Cifrado simétrico AES-256-GCM para datos sensibles del tenant
 * (mh_password, firmador_password). Guardamos en DB como base64 de:
 *   [iv(12)][authTag(16)][ciphertext]
 *
 * La key viene de env `TENANT_SECRETS_KEY` (32 bytes en base64). Si cambia,
 * todos los _enc actuales se vuelven ilegibles — rotar requiere script de
 * re-encryption antes del cambio.
 *
 * Threat model:
 *   - Defiende contra dump de Postgres sin la key.
 *   - NO defiende contra app comprometida (la key vive en memoria del proceso).
 *   - Para harden: KMS / Vault en una pasada posterior.
 */

const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.TENANT_SECRETS_KEY;
  if (!raw) {
    throw new Error('TENANT_SECRETS_KEY no configurada (generar: openssl rand -base64 32)');
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error(`TENANT_SECRETS_KEY debe ser 32 bytes (256 bits), got ${buf.length}`);
  }
  cachedKey = buf;
  return buf;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptSecret(payload: string): string {
  const buf = Buffer.from(payload, 'base64');
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error('ciphertext corrupto (longitud insuficiente)');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALG, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
