import { z } from 'zod';

export const PlatformCodeSchema = z.enum([
  'official_site',
  'baijiahao',
  'toutiao',
  'zhihu',
  'xiaohongshu',
  'wechat_mp',
  'douyin',
]);
export const KeywordIntentSchema = z.enum([
  'informational',
  'commercial',
  'transactional',
  'navigational',
]);
export const KeywordStatusSchema = z.enum(['active', 'disabled']);

export const KeywordInputSchema = z
  .object({
    intent: KeywordIntentSchema,
    platform_scope: z.array(PlatformCodeSchema).min(1),
    priority: z.number().int().min(0).max(100),
    status: KeywordStatusSchema,
    synonyms: z.array(z.string().trim().min(1).max(240)).max(50),
    term: z.string().trim().min(1).max(240),
  })
  .strict();

export const KeywordSchema = KeywordInputSchema.extend({
  created_at: z.iso.datetime(),
  id: z.string().uuid(),
  keyword_set_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  updated_at: z.iso.datetime(),
}).strict();

export const KeywordSetSchema = z
  .object({
    created_at: z.iso.datetime(),
    id: z.string().uuid(),
    name: z.string().min(1),
    project_id: z.string().uuid(),
    status: z.enum(['active', 'archived']),
    tenant_id: z.string().uuid(),
    updated_at: z.iso.datetime(),
  })
  .strict();

const RequestMetaSchema = z.object({ request_id: z.string().min(1) }).strict();

export const KeywordSetPageSchema = z
  .object({
    data: z.array(KeywordSetSchema),
    meta: RequestMetaSchema.extend({ next_cursor: z.string().nullable() }),
  })
  .strict();

export const KeywordSetDetailResponseSchema = z
  .object({
    data: KeywordSetSchema.extend({ keywords: z.array(KeywordSchema) }).strict(),
    meta: RequestMetaSchema,
  })
  .strict();

export const KeywordListResponseSchema = z
  .object({ data: z.array(KeywordSchema), meta: RequestMetaSchema })
  .strict();

export type Keyword = z.infer<typeof KeywordSchema>;
export type KeywordInput = z.infer<typeof KeywordInputSchema>;
export type KeywordIntent = z.infer<typeof KeywordIntentSchema>;
export type KeywordSet = z.infer<typeof KeywordSetSchema>;
export type KeywordSetDetail = z.infer<typeof KeywordSetDetailResponseSchema>['data'];
export type KeywordStatus = z.infer<typeof KeywordStatusSchema>;
export type PlatformCode = z.infer<typeof PlatformCodeSchema>;
