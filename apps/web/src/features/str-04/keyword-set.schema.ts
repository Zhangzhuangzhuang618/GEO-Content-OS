import { z } from 'zod';

export const PlatformCodeSchema = z.enum([
  'official_site',
  'baijiahao',
  'sohu',
  'lieju',
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
export const KeywordSortSchema = z.enum(['priority_desc', 'priority_asc']);
export const KeywordSourceIntentSchema = z.enum([
  '价格咨询',
  '信任筛选',
  '本地搜索',
  '品质筛选',
  '价格筛选',
  '联系方式',
  '商圈/街道搜索',
  '即时需求',
  '路线需求',
  '时间需求',
  '比较选择',
  '预约转化',
  '服务方式',
  '核心服务',
  '服务咨询',
  '预约咨询',
  '避坑咨询',
  '时效咨询',
  '攻略咨询',
]);
export const KeywordSuggestedPageTypeSchema = z.enum([
  '服务页',
  '报价页',
  '联系页',
  '对比页',
  '场景页',
  '企业服务页',
  '预约页',
  '问答页',
  '单项服务页',
  '车型页',
]);
const KeywordIntentsSchema = z
  .array(KeywordIntentSchema)
  .min(1)
  .max(KeywordIntentSchema.options.length)
  .refine((values) => new Set(values).size === values.length);

export const KeywordInputSchema = z
  .object({
    intents: KeywordIntentsSchema,
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

export const KeywordSetResponseSchema = z
  .object({ data: KeywordSetSchema, meta: RequestMetaSchema })
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

export const BatchKeywordOperationResponseSchema = z
  .object({
    data: z
      .object({
        action: z.enum(['disable', 'delete', 'update']),
        affected_count: z.number().int().nonnegative(),
        keyword_ids: z.array(z.string().uuid()).min(1).max(500).nullable(),
        skipped_referenced_count: z.number().int().nonnegative(),
      })
      .strict(),
    meta: RequestMetaSchema,
  })
  .strict();

export const KeywordPageSchema = z
  .object({
    data: z.array(KeywordSchema),
    meta: RequestMetaSchema.extend({
      next_cursor: z.string().nullable(),
      page: z.number().int().positive().nullable(),
      page_size: z.number().int().positive(),
      total_count: z.number().int().nonnegative(),
      total_pages: z.number().int().positive(),
    }),
  })
  .strict();

const ImportCountSchema = z
  .object({ count: z.number().int().nonnegative(), label: z.string().min(1) })
  .strict();

export const KeywordImportJobSchema = z
  .object({
    candidate_count: z.number().int().nonnegative(),
    content_hash: z.string().regex(/^[0-9a-f]{64}$/u),
    created_at: z.iso.datetime(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        schema_version: z.literal('keyword-import-error@1'),
      })
      .strict()
      .nullable(),
    file_name: z.string().min(1),
    folded_row_count: z.number().int().nonnegative(),
    id: z.string().uuid(),
    imported_count: z.number().int().nonnegative(),
    invalid_row_count: z.number().int().nonnegative(),
    keyword_set_id: z.string().uuid(),
    selected_count: z.number().int().nonnegative(),
    sheet_name: z.string().min(1),
    status: z.enum(['preflight_ready', 'queued', 'running', 'succeeded', 'failed']),
    summary: z
      .object({
        candidate_samples: z
          .array(
            z
              .object({
                intents: KeywordIntentsSchema,
                source_intent: KeywordSourceIntentSchema,
                suggested_page_type: KeywordSuggestedPageTypeSchema,
                synonyms: z.array(z.string()),
                term: z.string(),
              })
              .strict(),
          )
          .max(20),
        page_types: z.array(ImportCountSchema),
        source_intents: z.array(ImportCountSchema),
      })
      .strict(),
    tenant_id: z.string().uuid(),
    total_row_count: z.number().int().nonnegative(),
    updated_at: z.iso.datetime(),
  })
  .strict();

export const KeywordImportJobResponseSchema = z
  .object({ data: KeywordImportJobSchema, meta: RequestMetaSchema })
  .strict();

export type Keyword = z.infer<typeof KeywordSchema>;
export type BatchKeywordOperation = z.infer<typeof BatchKeywordOperationResponseSchema>['data'];
export type KeywordInput = z.infer<typeof KeywordInputSchema>;
export type KeywordIntent = z.infer<typeof KeywordIntentSchema>;
export type KeywordImportJob = z.infer<typeof KeywordImportJobSchema>;
export type KeywordSourceIntent = z.infer<typeof KeywordSourceIntentSchema>;
export type KeywordSuggestedPageType = z.infer<typeof KeywordSuggestedPageTypeSchema>;
export type KeywordSet = z.infer<typeof KeywordSetSchema>;
export type KeywordSetDetail = z.infer<typeof KeywordSetDetailResponseSchema>['data'];
export type KeywordStatus = z.infer<typeof KeywordStatusSchema>;
export type KeywordSort = z.infer<typeof KeywordSortSchema>;
export type PlatformCode = z.infer<typeof PlatformCodeSchema>;
