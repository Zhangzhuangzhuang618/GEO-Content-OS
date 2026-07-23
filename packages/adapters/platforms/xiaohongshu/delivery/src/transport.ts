import { XiaohongshuDeliveryError } from './errors.js';
import type {
  XiaohongshuHttpRequest,
  XiaohongshuHttpResponse,
  XiaohongshuHttpTransport,
} from './types.js';

export class FetchXiaohongshuTransport implements XiaohongshuHttpTransport {
  public constructor(private readonly timeoutMs: number) {}

  public async request(input: XiaohongshuHttpRequest): Promise<XiaohongshuHttpResponse> {
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
        throw new XiaohongshuDeliveryError(
          'REMOTE_RESPONSE_INVALID',
          'Xiaohongshu returned non-JSON data',
        );
      }
    }
    return { body, status_code: response.status };
  }
}
