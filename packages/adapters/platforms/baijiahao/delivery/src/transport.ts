import type {
  BaijiahaoHttpRequest,
  BaijiahaoHttpResponse,
  BaijiahaoHttpTransport,
} from './types.js';

export class FetchBaijiahaoTransport implements BaijiahaoHttpTransport {
  public constructor(private readonly timeoutMs: number) {}

  public async request(input: BaijiahaoHttpRequest): Promise<BaijiahaoHttpResponse> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    const response = await fetch(input.url, {
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      headers: { ...input.headers },
      method: input.method,
      redirect: 'error',
      signal,
    });
    const text = await response.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    return { body, status_code: response.status };
  }
}
