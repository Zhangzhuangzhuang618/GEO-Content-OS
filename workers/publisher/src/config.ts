import {
  CredentialEnvelopeService,
  LocalCredentialKms,
} from '@geo-content-os/security/credentials';
import { z } from 'zod';

const PublisherWorkerConfigSchema = z
  .object({
    databaseUrl: z.string().trim().min(1),
    healthPort: z.number().int().min(1).max(65_535),
    lockDurationMs: z.number().int().min(60_000).max(900_000),
    queueConcurrency: z.number().int().min(1).max(100),
    redisUrl: z.url(),
    staleAfterMs: z.number().int().min(1_000).max(900_000),
  })
  .strict();

export type PublisherWorkerConfig = z.infer<typeof PublisherWorkerConfigSchema>;

export function readPublisherWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): PublisherWorkerConfig {
  return PublisherWorkerConfigSchema.parse({
    databaseUrl: environment['DATABASE_URL'],
    healthPort: integer(environment['HEALTH_PORT'], 9090),
    lockDurationMs: integer(environment['PUBLISHER_QUEUE_LOCK_DURATION_MS'], 600_000),
    queueConcurrency: integer(environment['PUBLISHER_WORKER_CONCURRENCY'], 1),
    redisUrl: environment['REDIS_URL'],
    staleAfterMs: integer(environment['PUBLISHER_STALE_AFTER_MS'], 600_000),
  });
}

export function createPublisherCredentialService(
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
  if (value === undefined || value.trim() === '') return fallback;
  return Number(value);
}
