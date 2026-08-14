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

export const LiejuPostingProfileSchema = z
  .object({
    address: z.string().trim().min(1).max(120),
    category_id: z.enum(['1', '2', '3', '4', '5', '6']),
    contact_name: z.string().trim().min(1).max(25),
    mobile_phone: z.string().trim().min(6).max(20),
    qq: z.string().trim().max(15).default(''),
    street_id: z
      .string()
      .regex(/^\d{1,8}$/u)
      .nullable()
      .default(null),
    wechat: z.string().trim().max(25).default(''),
    zone_id: z.enum([
      '73',
      '3038',
      '3037',
      '3036',
      '83',
      '82',
      '81',
      '80',
      '79',
      '78',
      '77',
      '76',
      '75',
      '74',
      '3081',
    ]),
  })
  .strict();

export type LiejuPostingProfile = z.infer<typeof LiejuPostingProfileSchema>;

export const LiejuDeliveryConfigSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('export_only') }).strict(),
  z
    .object({
      account_id: z.string().uuid().optional(),
      base_url: z.url().refine(isSafeBaseUrl),
      bearer_token: z.string().trim().min(1),
      endpoints: EndpointSchema.default({
        capabilities: '/capabilities',
        metrics: '/metrics',
        publish: '/publish',
        status: '/status',
      }),
      mode: z.literal('api'),
      posting_profile: LiejuPostingProfileSchema,
      timeout_ms: z.number().int().min(100).max(60_000).default(60_000),
    })
    .strict(),
]);

export type LiejuDeliveryConfig = z.infer<typeof LiejuDeliveryConfigSchema>;

export function parseLiejuDeliveryConfig(input: unknown): LiejuDeliveryConfig {
  return LiejuDeliveryConfigSchema.parse(input);
}

function isSafeBaseUrl(value: string): boolean {
  const url = new URL(value);
  return (
    ['http:', 'https:'].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}
