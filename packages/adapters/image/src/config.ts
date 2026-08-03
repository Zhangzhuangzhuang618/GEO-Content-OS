import type { ImageProviderConfiguration } from './types.js';

export type ImageProviderDriver = 'cloudflare' | 'disabled';

export interface ImageProviderRuntimeConfiguration {
  readonly driver: ImageProviderDriver;
  readonly provider: ImageProviderConfiguration | null;
}

const DEFAULT_GENERATION_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const DEFAULT_INSPECTION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

export function readImageProviderConfiguration(
  environment = process.env,
): ImageProviderRuntimeConfiguration {
  const driver = environment['IMAGE_GENERATION_DRIVER']?.trim() || 'disabled';
  if (driver !== 'cloudflare' && driver !== 'disabled') {
    throw new Error('IMAGE_GENERATION_DRIVER must be cloudflare or disabled');
  }
  if (driver === 'disabled') return Object.freeze({ driver, provider: null });
  return Object.freeze({
    driver,
    provider: Object.freeze({
      accountId: required(environment['CLOUDFLARE_ACCOUNT_ID'], 'CLOUDFLARE_ACCOUNT_ID'),
      apiToken: required(environment['CLOUDFLARE_API_TOKEN'], 'CLOUDFLARE_API_TOKEN'),
      generationModel: model(
        environment['CLOUDFLARE_IMAGE_MODEL'] ?? DEFAULT_GENERATION_MODEL,
        'CLOUDFLARE_IMAGE_MODEL',
      ),
      inspectionModel: model(
        environment['CLOUDFLARE_IMAGE_QA_MODEL'] ?? DEFAULT_INSPECTION_MODEL,
        'CLOUDFLARE_IMAGE_QA_MODEL',
      ),
      timeoutMs: milliseconds(environment['IMAGE_PROVIDER_TIMEOUT_MS']),
    }),
  });
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim())
    throw new Error(`${name} is required when Cloudflare image generation is enabled`);
  return value.trim();
}

function model(value: string, name: string): string {
  const normalized = value.trim();
  if (!/^@cf\/[a-z0-9._-]+\/[a-z0-9._-]+$/u.test(normalized)) {
    throw new Error(`${name} must be a Cloudflare-hosted @cf model id`);
  }
  return normalized;
}

function milliseconds(value: string | undefined): number {
  const parsed = value === undefined ? 120_000 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 5_000 || parsed > 300_000) {
    throw new Error('IMAGE_PROVIDER_TIMEOUT_MS must be an integer between 5000 and 300000');
  }
  return parsed;
}
