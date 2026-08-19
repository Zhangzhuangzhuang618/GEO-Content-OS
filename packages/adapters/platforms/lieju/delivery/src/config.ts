import { z } from 'zod';

export const LIEJU_OFFICIAL_API_ENDPOINT =
  'https://post.lieju.com/post_api.php?action=postnew' as const;

const ZoneIdSchema = z.enum([
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
]);

const MobilePhoneSchema = z
  .string()
  .trim()
  .regex(/^(?:[0-9]{6,12}|[0-9]{3,4}-[0-9]{6,8}(?:-[0-9]{1,6})?)$/u);
const QqSchema = z
  .string()
  .trim()
  .regex(/^(?:[0-9]{5,15})?$/u)
  .default('');
const WechatSchema = z
  .string()
  .trim()
  .regex(/^(?:[A-Za-z][-_A-Za-z0-9]{5,19})?$/u)
  .default('');

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
    mobile_phone: MobilePhoneSchema,
    qq: QqSchema,
    street_id: z
      .string()
      .regex(/^\d{1,8}$/u)
      .nullable()
      .default(null),
    wechat: WechatSchema,
    zone_id: ZoneIdSchema,
  })
  .strict();

export type LiejuPostingProfile = z.infer<typeof LiejuPostingProfileSchema>;

export const LiejuOfficialPostingProfileSchema = z
  .object({
    address: z.string().trim().min(1).max(120),
    category_id: z.enum(['1', '2', '3', '4', '5', '6']).default('4'),
    contact_name: z.string().trim().min(1).max(25),
    mobile_phone: MobilePhoneSchema,
    qq: QqSchema,
    wechat: WechatSchema,
    zone_id: ZoneIdSchema,
  })
  .strict();

export type LiejuOfficialPostingProfile = z.infer<typeof LiejuOfficialPostingProfileSchema>;

export const LiejuDeliveryConfigSchema = z.union([
  z.object({ mode: z.literal('export_only') }).strict(),
  z
    .object({
      account_id: z.string().uuid().optional(),
      base_url: z.url().refine(isSafeBaseUrl),
      bearer_token: z.string().trim().min(1),
      delivery_method: z.literal('browser_gateway').default('browser_gateway'),
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
  z
    .object({
      api_key: z
        .string()
        .trim()
        .min(16)
        .max(256)
        .regex(/^[\x21-\x7e]+$/u),
      city_id: z.literal('5').default('5'),
      delivery_method: z.literal('official_api'),
      endpoint: z.literal(LIEJU_OFFICIAL_API_ENDPOINT).default(LIEJU_OFFICIAL_API_ENDPOINT),
      fid: z.literal('73').default('73'),
      mode: z.literal('api'),
      posting_profile: LiejuOfficialPostingProfileSchema,
      timeout_ms: z.number().int().min(100).max(60_000).default(20_000),
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
