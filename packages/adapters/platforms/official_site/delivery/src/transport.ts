import type {
  OfficialSiteHttpRequest,
  OfficialSiteHttpResponse,
  OfficialSiteHttpTransport,
} from './types.js';

export class FetchOfficialSiteTransport implements OfficialSiteHttpTransport {
  public constructor(private readonly timeoutMs: number) {}

  public async request(input: OfficialSiteHttpRequest): Promise<OfficialSiteHttpResponse> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    const body =
      input.body === undefined
        ? undefined
        : input.body instanceof Uint8Array
          ? Buffer.from(input.body)
          : JSON.stringify(input.body);
    const response = await fetch(input.url, {
      ...(body === undefined ? {} : { body }),
      headers: { ...input.headers },
      method: input.method,
      redirect: 'error',
      signal,
    });
    const text = await response.text();
    let responseBody: unknown = null;
    if (text.length > 0) {
      try {
        responseBody = JSON.parse(text) as unknown;
      } catch {
        responseBody = text;
      }
    }
    return { body: responseBody, status_code: response.status };
  }
}
