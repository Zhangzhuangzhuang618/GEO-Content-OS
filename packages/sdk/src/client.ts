import { operations, type OperationId } from './generated/operations.js';

export interface GeoContentOsClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface ApiRequestOptions {
  readonly body?: FormData | unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly path?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, boolean | number | string | undefined>>;
}

export class GeoApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly response: unknown,
  ) {
    super(`GEO Content OS API request failed with status ${status}`);
  }
}

export class GeoContentOsClient {
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof globalThis.fetch;

  public constructor(options: GeoContentOsClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/u, '');
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  public async request<TResponse = unknown>(
    operationId: OperationId,
    options: ApiRequestOptions = {},
  ): Promise<TResponse> {
    const operation = operations[operationId];
    const route = operation.path.replace(/\{([^}]+)\}/gu, (_match, name: string) => {
      const value = options.path?.[name];
      if (!value) throw new Error(`Missing path parameter: ${name}`);
      return encodeURIComponent(value);
    });
    const url = new URL(`${this.baseUrl}${route}`);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    const headers = new Headers(options.headers);
    const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
    if (options.body !== undefined && !isFormData && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    const response = await this.fetchImplementation(url, {
      ...(options.body === undefined
        ? {}
        : {
            body: isFormData ? (options.body as FormData) : JSON.stringify(options.body),
          }),
      credentials: 'include',
      headers,
      method: operation.method,
    });
    if (!response.ok) throw new GeoApiError(response.status, await readResponse(response));
    return (await readResponse(response)) as TResponse;
  }
}

async function readResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const contentType = response.headers.get('content-type') ?? '';
  return contentType.includes('application/json') ? response.json() : response.text();
}
