import { TransientError } from '../errors.js';

export interface HttpResponse<T> {
  status: number;
  body: T;
}

interface PostOptions {
  headers?: Record<string, string>;
  /** json (default) → JSON body. form → application/x-www-form-urlencoded. */
  bodyKind?: 'json' | 'form';
  maxRetries?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
}

/**
 * POST con retry exponencial + jitter para errores transitorios (5xx, 429, red).
 * Para 4xx el caller decide qué hacer — devolvemos status + body sin lanzar.
 * Para 5xx/429 lanzamos `TransientError` después de agotar reintentos.
 */
export async function postJson<T = unknown>(
  url: string,
  body: unknown,
  opts: PostOptions = {},
): Promise<HttpResponse<T>> {
  const {
    maxRetries = 3,
    baseDelayMs = 500,
    timeoutMs = 30_000,
    headers = {},
    bodyKind = 'json',
  } = opts;

  const finalHeaders: Record<string, string> = { Accept: 'application/json', ...headers };
  let payload: string;
  if (bodyKind === 'form') {
    finalHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(body as Record<string, string>).toString();
  } else {
    finalHeaders['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let lastErr: TransientError | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: finalHeaders,
        body: payload,
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = { raw: text };
      }

      if (res.status >= 500 || res.status === 429) {
        lastErr = new TransientError(`HTTP ${res.status} from ${url}`, {
          url, status: res.status, body: parsed,
        });
        if (attempt < maxRetries) {
          await sleep(jitterBackoff(baseDelayMs, attempt));
          continue;
        }
        throw lastErr;
      }
      return { status: res.status, body: parsed as T };
    } catch (e) {
      if (e instanceof TransientError) throw e;
      lastErr = new TransientError(
        e instanceof Error ? e.message : String(e),
        { url, error: String(e) },
      );
      if (attempt < maxRetries) {
        await sleep(jitterBackoff(baseDelayMs, attempt));
        continue;
      }
      throw lastErr;
    } finally {
      clearTimeout(timer);
    }
  }
  // Inalcanzable — por si TS no lo deduce.
  throw lastErr ?? new TransientError('Fallo desconocido en postJson', { url });
}

function jitterBackoff(base: number, attempt: number): number {
  const exp = base * Math.pow(2, attempt);
  return exp + Math.random() * exp * 0.5;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
