import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/env', () => ({ env: { adapter: 'api', dteServiceUrl: 'http://dte' } }));

// Las pruebas corren en Node: localStorage en memoria
const mem = new Map<string, string>();
const stubStorage = () => vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), clear: () => mem.clear(),
});
stubStorage();

const login = (tenant_id: number | null) =>
  localStorage.setItem('pipeline-auth', JSON.stringify({ access_token: 'tok', user: { tenant_id } }));

describe('rutas del dte-service por empresa', () => {
  afterEach(() => { mem.clear(); vi.unstubAllGlobals(); stubStorage(); });

  it('PAAJ (tenant 1) sigue por las rutas originales; las demás por /v2 con token', async () => {
    const { usesTenantDteApi, dteAuthHeaders } = await import('./tenant-routing');
    login(1);
    expect(usesTenantDteApi()).toBe(false);
    login(2);
    expect(usesTenantDteApi()).toBe(true);
    expect(dteAuthHeaders()).toEqual({ Authorization: 'Bearer tok' });
  });

  it('el próximo correlativo de otra empresa sale de /v2, no del tenant 1', async () => {
    login(2);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [{ tipo_dte: '03', seeded: true, ultimo_consumido: 60 }] })));
    vi.stubGlobal('fetch', fetchMock);
    const { peekCorrelativo } = await import('./correlativos-client');
    const r = await peekCorrelativo('03');
    expect(r.ultimo_consumido + 1).toBe(61);
    expect(fetchMock).toHaveBeenCalledWith('http://dte/v2/correlativos/listar', { headers: { Authorization: 'Bearer tok' } });
  });
});
