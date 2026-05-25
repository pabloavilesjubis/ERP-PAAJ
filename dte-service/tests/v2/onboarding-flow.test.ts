import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret } from '../../src/auth/crypto.js';
import { configForTenant } from '../../src/tenants/emisor.adapter.js';
import type { TenantEmisorFull } from '../../src/tenants/tenant.types.js';
import type { Config } from '../../src/config.js';

// Setear key dummy para el crypto test
process.env.TENANT_SECRETS_KEY = process.env.TENANT_SECRETS_KEY
  ?? Buffer.alloc(32, 'A').toString('base64');

describe('crypto AES-256-GCM tenant secrets', () => {
  it('encrypt/decrypt round-trip', () => {
    const plain = 'mi_password_super_secreto_$%@';
    const enc = encryptSecret(plain);
    expect(enc).not.toEqual(plain);
    expect(enc.length).toBeGreaterThan(plain.length);
    expect(decryptSecret(enc)).toEqual(plain);
  });

  it('two encryptions of the same plaintext produce diferentes ciphertexts (IV random)', () => {
    const a = encryptSecret('foo');
    const b = encryptSecret('foo');
    expect(a).not.toEqual(b);
    expect(decryptSecret(a)).toEqual('foo');
    expect(decryptSecret(b)).toEqual('foo');
  });

  it('tampered ciphertext fails GCM auth tag', () => {
    const enc = encryptSecret('foo');
    const tampered = Buffer.from(enc, 'base64');
    const lastIdx = tampered.length - 1;
    tampered[lastIdx] = (tampered[lastIdx] ?? 0) ^ 0x01;
    expect(() => decryptSecret(tampered.toString('base64'))).toThrow();
  });
});

describe('emisor adapter — configForTenant', () => {
  const globalCfg = {
    NODE_ENV: 'test', LOG_LEVEL: 'info', PORT: 3000,
    FIRMADOR_URL: 'http://firmador:8113',
    STORAGE_DIR: '/app/data', BEON_ALLOWED_ORIGINS: '',
  } as unknown as Config;

  const emisor: TenantEmisorFull = {
    tenant_id: 7,
    mh_env: 'sandbox',
    mh_nit: '12345678901234',
    mh_password: 'mh_pass',
    firmador_password: 'firmador_pass',
    cert_path: '/app/certs/12345678901234.crt',
    emisor_nrc: '1234567',
    emisor_nombre: 'ACME SA DE CV',
    emisor_cod_actividad: '47711',
    emisor_desc_actividad: 'Comercio',
    emisor_tipo_establecimiento: '02',
    emisor_departamento: '06',
    emisor_municipio: '14',
    emisor_complemento: 'Calle Test',
    emisor_telefono: null,
    emisor_email: 'acme@test.sv',
    punto_venta_establecimiento: 'M001',
    punto_venta_punto: 'P000',
    emisor_cod_estable_mh: 'M001',
    emisor_cod_punto_venta_mh: 'P000',
  };

  it('mezcla globalCfg + emisor preservando ambos', () => {
    const cfg = configForTenant(globalCfg, emisor);
    expect(cfg.MH_NIT).toBe('12345678901234');
    expect(cfg.MH_PASSWORD).toBe('mh_pass');
    expect(cfg.FIRMADOR_PASSWORD).toBe('firmador_pass');
    expect(cfg.EMISOR_NOMBRE).toBe('ACME SA DE CV');
    expect(cfg.PUNTO_VENTA_ESTABLECIMIENTO).toBe('M001');
    expect(cfg.FIRMADOR_URL).toBe('http://firmador:8113');  // global preservado
    expect(cfg.MH_ENV).toBe('sandbox');
  });

  it('genera Config válido para builders (con todos los campos required)', () => {
    const cfg = configForTenant(globalCfg, emisor);
    // Los builders esperan estos exactamente
    expect(cfg.PUNTO_VENTA_ESTABLECIMIENTO).toMatch(/^[A-Z0-9]{4}$/);
    expect(cfg.PUNTO_VENTA_PUNTO).toMatch(/^[A-Z0-9]{4}$/);
    expect(cfg.MH_NIT).toMatch(/^\d{14}$/);
  });
});
