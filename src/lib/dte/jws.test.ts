import { describe, expect, it } from 'vitest';
import { dteFromJws, dteJsonDocument } from './jws';

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const JWS = `${b64url('{"alg":"RS512"}')}.${b64url(JSON.stringify({ sujetoExcluido: { nombre: 'José Núñez Ávila' } }))}.firma`;

describe('DTE dentro del JWS', () => {
  it('decodifica el payload como UTF-8', () => {
    expect((dteFromJws(JWS)?.sujetoExcluido as { nombre: string }).nombre).toBe('José Núñez Ávila');
    expect(dteFromJws('no-es-jws')).toBeNull();
  });
  it('arma el JSON como lo entrega el MH: DTE + firma + sello', () => {
    expect(dteJsonDocument(JWS, 'SELLO')).toMatchObject({ firmaElectronica: JWS, selloRecibido: 'SELLO' });
  });
});
