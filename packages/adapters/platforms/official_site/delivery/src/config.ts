import { z } from 'zod';

const ApiPathSchema = z
  .string()
  .regex(/^\/(?!\/)[A-Za-z0-9/_-]*$/u)
  .refine((value) => !value.includes('..'));

const EndpointSchema = z
  .object({
    capabilities: ApiPathSchema.default('/capabilities'),
    metrics: ApiPathSchema.default('/metrics'),
    publish: ApiPathSchema.default('/publish'),
    status: ApiPathSchema.default('/status'),
  })
  .strict();

export const OfficialSiteDeliveryConfigSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('export_only') }).strict(),
  z
    .object({
      base_url: z.url().refine(isSafeBaseUrl),
      bearer_token: z.string().trim().min(1),
      endpoints: EndpointSchema.default({
        capabilities: '/capabilities',
        metrics: '/metrics',
        publish: '/publish',
        status: '/status',
      }),
      mode: z.literal('api'),
      timeout_ms: z.number().int().min(100).max(60_000).default(10_000),
    })
    .strict(),
]);

export type OfficialSiteDeliveryConfig = z.infer<typeof OfficialSiteDeliveryConfigSchema>;

export function parseOfficialSiteDeliveryConfig(input: unknown): OfficialSiteDeliveryConfig {
  return OfficialSiteDeliveryConfigSchema.parse(input);
}

function isSafeBaseUrl(value: string): boolean {
  const url = new URL(value);
  const loopbackHosts = new Set(['127.0.0.1', '::1', 'localhost']);
  return (
    (url.protocol === 'https:' ||
      (url.protocol === 'http:' && loopbackHosts.has(url.hostname.toLowerCase()))) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}
