import { ZhihuDeliveryError } from './errors.js';
import type { ZhihuHttpRequest, ZhihuHttpResponse, ZhihuHttpTransport } from './types.js';

export class FetchZhihuTransport implements ZhihuHttpTransport {
  public constructor(private readonly timeoutMs: number) {}

  public async request(input: ZhihuHttpRequest): Promise<ZhihuHttpResponse> {
    const response = await fetch(input.url, {
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      headers: input.headers,
      method: input.method,
      redirect: 'error',
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(this.timeoutMs)])
        : AbortSignal.timeout(this.timeoutMs),
    });
    let body: unknown = null;
    const text = await response.text();
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        throw new ZhihuDeliveryError('REMOTE_RESPONSE_INVALID', 'Zhihu returned non-JSON data');
      }
    }
    return { body, status_code: response.status };
  }
}
