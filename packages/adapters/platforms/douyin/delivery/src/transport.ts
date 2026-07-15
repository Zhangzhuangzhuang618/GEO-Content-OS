import { DouyinDeliveryError } from './errors.js';
import type { DouyinHttpRequest, DouyinHttpResponse, DouyinHttpTransport } from './types.js';

export class FetchDouyinTransport implements DouyinHttpTransport {
  public constructor(private readonly timeoutMs: number) {}
  public async request(input: DouyinHttpRequest): Promise<DouyinHttpResponse> {
    const response = await fetch(input.url, {
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      headers: input.headers,
      method: input.method,
      redirect: 'error',
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(this.timeoutMs)])
        : AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        throw new DouyinDeliveryError('REMOTE_RESPONSE_INVALID', 'Douyin returned non-JSON data');
      }
    }
    return { body, status_code: response.status };
  }
}
