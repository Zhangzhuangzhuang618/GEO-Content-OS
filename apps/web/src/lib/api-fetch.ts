interface ApiGetOptions {
  readonly cacheTtlMs?: number;
  readonly signal?: AbortSignal | undefined;
}

interface CachedResponse {
  readonly expiresAt: number;
  readonly response: Response;
}

const cachedResponses = new Map<string, CachedResponse>();
const inFlightRequests = new Map<string, Promise<Response>>();
let rateLimitedUntil = 0;

export async function apiGet(url: string, options: ApiGetOptions = {}): Promise<Response> {
  const now = Date.now();
  if (rateLimitedUntil > now) {
    return rateLimitedResponse(Math.max(1, Math.ceil((rateLimitedUntil - now) / 1_000)));
  }

  const cached = cachedResponses.get(url);
  if (cached && cached.expiresAt > now) {
    return withAbort(Promise.resolve(cached.response.clone()), options.signal);
  }
  if (cached) cachedResponses.delete(url);

  let pending = inFlightRequests.get(url);
  if (!pending) {
    pending = fetch(url, { credentials: 'include', method: 'GET' }).then((response) => {
      if (response.status === 429) {
        const retryAfterSeconds = parseRetryAfter(response.headers.get('Retry-After'));
        if (retryAfterSeconds !== null) {
          rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + retryAfterSeconds * 1_000);
        }
      } else if (response.ok && options.cacheTtlMs && options.cacheTtlMs > 0) {
        cachedResponses.set(url, {
          expiresAt: Date.now() + options.cacheTtlMs,
          response: response.clone(),
        });
      }
      return response;
    });
    inFlightRequests.set(url, pending);
    void pending.then(
      () => inFlightRequests.delete(url),
      () => inFlightRequests.delete(url),
    );
  }

  return withAbort(
    pending.then((response) => response.clone()),
    options.signal,
  );
}

export function invalidateApiGetCache(): void {
  cachedResponses.clear();
}

export function resetApiGetStateForTests(): void {
  cachedResponses.clear();
  inFlightRequests.clear();
  rateLimitedUntil = 0;
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}

function rateLimitedResponse(retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: 'RATE_LIMITED',
        message: '请求过于频繁，请稍后重试',
        request_id: 'client-rate-limit',
      },
    }),
    {
      headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfterSeconds) },
      status: 429,
    },
  );
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted)
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
