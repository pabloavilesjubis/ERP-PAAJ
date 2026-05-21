import { afterEach, describe, expect, it, vi } from 'vitest';
import { firmar } from '../../src/signing/firmador.js';
import type { Config } from '../../src/config.js';

const cfg = {
  FIRMADOR_URL: 'http://localhost:8113',
  FIRMADOR_NIT: '06140000000000',
  FIRMADOR_PASSWORD: 'pwd',
} as unknown as Config;

afterEach(() => { vi.restoreAllMocks(); });

describe('firmar', () => {
  it('llama al firmador con shape esperado y devuelve el JWS', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'OK', body: 'header.payload.signature' }), { status: 200 }),
    );
    const jws = await firmar(cfg, { foo: 'bar' });
    expect(jws).toBe('header.payload.signature');
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('http://localhost:8113/firmardocumento/');
    const init = fetchSpy.mock.calls[0]?.[1];
    const sentBody = JSON.parse(init?.body as string);
    expect(sentBody).toEqual({
      nit: cfg.FIRMADOR_NIT,
      activo: true,
      passwordPri: cfg.FIRMADOR_PASSWORD,
      dteJson: { foo: 'bar' },
    });
  });

  it('lanza FirmadorError cuando el firmador responde status=ERROR', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'ERROR', body: 'cert vencido' }), { status: 200 }),
    );
    await expect(firmar(cfg, {})).rejects.toThrow(/Firmador rechazó/);
  });

  it('lanza FirmadorError cuando el firmador devuelve 5xx tras retries', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('boom', { status: 500 }),
    );
    await expect(firmar(cfg, {})).rejects.toThrow();
  });
});
