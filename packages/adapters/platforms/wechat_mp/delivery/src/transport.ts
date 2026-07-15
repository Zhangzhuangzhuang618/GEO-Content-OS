import { WechatMpDeliveryError } from './errors.js';
import type {
  WechatMpHttpRequest,
  WechatMpHttpResponse,
  WechatMpHttpTransport,
} from './types.js';

export class FetchWechatMpTransport implements WechatMpHttpTransport {
  public constructor(private readonly timeoutMs: number) {}

  public async request(input: WechatMpHttpRequest): Promise<WechatMpHttpResponse> {
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
        throw new WechatMpDeliveryError(
          'REMOTE_RESPONSE_INVALID',
          'Wechat MP returned non-JSON data',
        );
      }
    }
    return { body, status_code: response.status };
  }
}
