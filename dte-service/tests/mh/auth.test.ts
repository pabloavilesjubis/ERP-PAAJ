import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTokenCache, getToken } from '../../src/mh/auth.js';
import type { Config } from '../../src/config.js';

const cfg = {
  MH_ENV: 'sandbox',
  MH_NIT: '06140000000000',
  MH_PASSWORD: 'pwd',
} as unknown as Config;

beforeEach(() => {
  clearTokenCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getToken', () => {
  it('hace POST form-urlencoded a /seguridad/auth y devuelve token con prefijo Bearer', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'OK', body: { token: 'abc.def.ghi' } }), { status: 200 }),
    );
    const t = await getToken(cfg);
    expect(t).toBe('Bearer abc.def.ghi');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://apitest.dtes.mh.gob.sv/seguridad/auth',
      expect.objectContaining({ method: 'POST' }),
    );
    const init = fetchSpy.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('respeta el prefijo Bearer si el MH ya lo incluye', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'OK', body: { token: 'Bearer xyz' } }), { status: 200 }),
    );
    expect(await getToken(cfg)).toBe('Bearer xyz');
  });

  it('cachea el token y no re-llama en la segunda invocación', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response(
        JSON.stringify({ status: 'OK', body: { token: 'cached' } }),
        { status: 200 },
      )),
    );
    await getToken(cfg);
    await getToken(cfg);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('fuerza refresh con force=true', async () => {
    // mockImplementation crea una Response nueva por llamada — cada body es
    // de un solo uso, no se puede compartir un mismo Response entre dos calls.
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response(
        JSON.stringify({ status: 'OK', body: { token: 'fresh' } }),
        { status: 200 },
      )),
    );
    await getToken(cfg);
    await getToken(cfg, true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('lanza AuthError si el MH responde sin OK', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'ERROR', error: { mensaje: 'Credenciales' } }), { status: 200 }),
    );
    await expect(getToken(cfg)).rejects.toThrow(/Login a MH falló/);
  });
});
