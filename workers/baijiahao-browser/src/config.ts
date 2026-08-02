import {
  CredentialEnvelopeService,
  LocalCredentialKms,
} from '@geo-content-os/security/credentials';
import { resolve } from 'node:path';
import { z } from 'zod';

const ConfigSchema = z
  .object({
    databaseUrl: z.string().trim().min(1),
    editorUrl: z.url(),
    gatewayToken: z.string().trim().min(32),
    headless: z.boolean(),
    healthPort: z.number().int().min(1).max(65_535),
    loginUrl: z.url(),
    manageUrl: z.url(),
    navigationTimeoutMs: z.number().int().min(1_000).max(120_000),
    profileRoot: z.string().trim().min(1),
    simulator: z.boolean(),
  })
  .strict();

export type BaijiahaoBrowserConfig = z.infer<typeof ConfigSchema>;

export function readBaijiahaoBrowserConfig(
  environment: NodeJS.ProcessEnv = process.env,
): BaijiahaoBrowserConfig {
  const simulator = boolean(environment['BAIJIAHAO_BROWSER_SIMULATOR'], false);
  const configuration = ConfigSchema.parse({
    databaseUrl: environment['DATABASE_URL'],
    editorUrl:
      environment['BAIJIAHAO_EDITOR_URL'] ??
      'https://baijiahao.baidu.com/builder/rc/edit?type=news',
    gatewayToken: environment['BAIJIAHAO_BROWSER_GATEWAY_TOKEN'],
    headless: boolean(environment['BAIJIAHAO_BROWSER_HEADLESS'], true),
    healthPort: integer(environment['HEALTH_PORT'], 9095),
    loginUrl: environment['BAIJIAHAO_LOGIN_URL'] ?? 'https://baijiahao.baidu.com/',
    manageUrl:
      environment['BAIJIAHAO_MANAGE_URL'] ?? 'https://baijiahao.baidu.com/builder/rc/content',
    navigationTimeoutMs: integer(environment['BAIJIAHAO_BROWSER_NAVIGATION_TIMEOUT_MS'], 30_000),
    profileRoot: resolve(
      environment['BAIJIAHAO_BROWSER_PROFILE_ROOT'] ?? '/var/lib/geo-content-os/baijiahao',
    ),
    simulator,
  });
  for (const field of ['loginUrl', 'editorUrl', 'manageUrl'] as const) {
    const url = new URL(configuration[field]);
    if (!simulator && url.protocol !== 'https:') {
      throw new Error(`${field} must use HTTPS outside the local simulator`);
    }
    if (simulator && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
      throw new Error(`${field} must target localhost in simulator mode`);
    }
  }
  return Object.freeze(configuration);
}

export function createBrowserCredentialService(
  environment: NodeJS.ProcessEnv = process.env,
): CredentialEnvelopeService {
  const encoded = environment['PUBLISHING_CREDENTIAL_KEY_BASE64']?.trim();
  if (!encoded) throw new Error('PUBLISHING_CREDENTIAL_KEY_BASE64 is required');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) {
    throw new Error('PUBLISHING_CREDENTIAL_KEY_BASE64 must decode to exactly 32 bytes');
  }
  const version = environment['PUBLISHING_CREDENTIAL_KEY_VERSION']?.trim() || 'local-v1';
  return new CredentialEnvelopeService(new LocalCredentialKms(version, { [version]: key }));
}

function integer(value: string | undefined, fallback: number): number {
  return value === undefined || value.trim() === '' ? fallback : Number(value);
}

function boolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('Boolean environment value must be true or false');
}
