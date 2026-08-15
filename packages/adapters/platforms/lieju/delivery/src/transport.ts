import type { LiejuHttpRequest, LiejuHttpResponse, LiejuHttpTransport } from './types.js';

export class FetchLiejuTransport implements LiejuHttpTransport {
  public constructor(private readonly timeoutMs: number) {}

  public async request(input: LiejuHttpRequest): Promise<LiejuHttpResponse> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    const response = await fetch(input.url, {
      ...(input.body === undefined
        ? {}
        : { body: input.body instanceof Uint8Array ? input.body : JSON.stringify(input.body) }),
      headers: { ...input.headers },
      method: input.method,
      redirect: 'error',
      signal,
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const text = new TextDecoder(
      input.response_encoding ?? responseCharset(response.headers.get('content-type')),
    ).decode(bytes);
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

function responseCharset(contentType: string | null): 'gbk' | 'utf-8' {
  return /charset\s*=\s*(?:gbk|gb2312|gb18030)/iu.test(contentType ?? '') ? 'gbk' : 'utf-8';
}
