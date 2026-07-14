import type { ModelCapabilities } from '@geo-content-os/adapter-model';

export interface DeepSeekAdapterConfiguration {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly maxOutputTokens: number;
  readonly maxRetries: number;
  readonly modelKey: string;
  readonly providerModelId: string;
  readonly retryBaseDelayMs: number;
  readonly timeoutMs: number;
}

export function loadDeepSeekAdapterConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): DeepSeekAdapterConfiguration {
  const configuration = {
    apiKey: environment.DEEPSEEK_API_KEY ?? '',
    baseUrl: environment.DEEPSEEK_BASE_URL ?? '',
    maxOutputTokens: integer(environment.DEEPSEEK_MAX_OUTPUT_TOKENS),
    maxRetries: integer(environment.DEEPSEEK_MAX_RETRIES),
    modelKey: environment.DEEPSEEK_MODEL_KEY ?? '',
    providerModelId: environment.DEEPSEEK_PROVIDER_MODEL_ID ?? '',
    retryBaseDelayMs: integer(environment.DEEPSEEK_RETRY_BASE_DELAY_MS),
    timeoutMs: integer(environment.DEEPSEEK_TIMEOUT_MS),
  };
  assertDeepSeekAdapterConfiguration(configuration);
  return Object.freeze(configuration);
}

export function assertDeepSeekAdapterConfiguration(
  configuration: DeepSeekAdapterConfiguration,
): void {
  let url: URL;
  try {
    url = new URL(configuration.baseUrl);
  } catch {
    throw new TypeError('DeepSeek base URL is invalid');
  }
  const localHttp =
    url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if (
    (url.protocol !== 'https:' && !localHttp) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !configuration.apiKey.trim() ||
    !identifier(configuration.modelKey, 80) ||
    !identifier(configuration.providerModelId, 160) ||
    !withinInteger(configuration.timeoutMs, 100, 120_000) ||
    !withinInteger(configuration.maxRetries, 0, 2) ||
    !withinInteger(configuration.retryBaseDelayMs, 0, 10_000) ||
    !withinInteger(configuration.maxOutputTokens, 1, 65_536)
  ) {
    throw new TypeError('DeepSeek Adapter configuration is invalid');
  }
}

export function deepSeekCapabilities(
  configuration: DeepSeekAdapterConfiguration,
): ModelCapabilities {
  return Object.freeze({
    jsonMode: true,
    jsonSchema: false,
    maxOutputTokens: configuration.maxOutputTokens,
    streaming: true,
    toolCalling: true,
  });
}

function integer(value: string | undefined): number {
  return value === undefined || !/^\d+$/u.test(value) ? Number.NaN : Number(value);
}

function identifier(value: string, maximum: number): boolean {
  return value.length <= maximum && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value);
}

function withinInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
