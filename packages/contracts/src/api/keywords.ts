import { z } from 'zod';

import { PLATFORM_CODES } from '../platforms.js';
import {
  CursorPageMetaSchema,
  CursorSchema,
  IsoDateTimeSchema,
  RequestMetaSchema,
  UuidSchema,
} from './common.js';

const KeywordTermSchema = z.string().trim().min(1).max(240);
export const KeywordIntentSchema = z.enum([
  'informational',
  'commercial',
  'transactional',
  'navigational',
]);

export const KeywordIntentsSchema = z
  .array(KeywordIntentSchema)
  .min(1)
  .max(KeywordIntentSchema.options.length)
  .refine((values) => new Set(values).size === values.length, {
    message: 'Keyword intents must be unique',
  });

const KeywordSynonymsSchema = z
  .array(z.string().trim().min(1).max(240))
  .max(50)
  .refine((values) => new Set(values.map((value) => value.toLowerCase())).size === values.length, {
    message: 'Keyword synonyms must be unique',
  });

export const KeywordPlatformScopeSchema = z
  .array(z.enum(PLATFORM_CODES))
  .min(1)
  .max(PLATFORM_CODES.length)
  .refine((values) => new Set(values).size === values.length, {
    message: 'Keyword platform scope values must be unique',
  });

export const CreateKeywordSetRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    project_id: UuidSchema,
  })
  .strict();

export const KeywordInputSchema = z
  .object({
    intents: KeywordIntentsSchema,
    platform_scope: KeywordPlatformScopeSchema,
    priority: z.number().int().min(0).max(100).default(50),
    status: z.enum(['active', 'disabled']).default('active'),
    synonyms: KeywordSynonymsSchema.default([]),
    term: KeywordTermSchema,
  })
  .strict();

export const UpsertKeywordsRequestSchema = z
  .object({
    keywords: z.array(KeywordInputSchema).min(1).max(500),
  })
  .strict()
  .superRefine((value, context) => {
    const indexes = new Map<string, number>();
    value.keywords.forEach((keyword, index) => {
      const normalized = keyword.term.toLowerCase();
      const previousIndex = indexes.get(normalized);
      if (previousIndex !== undefined) {
        context.addIssue({
          code: 'custom',
          message: `Keyword term duplicates item ${previousIndex}`,
          path: ['keywords', index, 'term'],
        });
      } else {
        indexes.set(normalized, index);
      }
    });
  });

const KeywordIdBatchSchema = z
  .array(UuidSchema)
  .min(1)
  .max(500)
  .refine((values) => new Set(values).size === values.length, {
    message: 'Keyword ids must be unique',
  });

const BatchKeywordChangesSchema = z
  .object({
    intents: KeywordIntentsSchema.optional(),
    platform_scope: KeywordPlatformScopeSchema.optional(),
    priority: z.number().int().min(0).max(100).optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, {
    message: 'At least one keyword field must be changed',
  });

export const BatchKeywordOperationRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('disable'), keyword_ids: KeywordIdBatchSchema }).strict(),
  z.object({ action: z.literal('delete'), keyword_ids: KeywordIdBatchSchema }).strict(),
  z
    .object({
      action: z.literal('update'),
      changes: BatchKeywordChangesSchema,
      keyword_ids: KeywordIdBatchSchema,
    })
    .strict(),
]);

export const BatchKeywordOperationSchema = z
  .object({
    action: z.enum(['disable', 'delete', 'update']),
    affected_count: z.number().int().nonnegative(),
    keyword_ids: KeywordIdBatchSchema,
  })
  .strict();

export const BatchKeywordOperationResponseSchema = z
  .object({ data: BatchKeywordOperationSchema, meta: RequestMetaSchema })
  .strict();

export const SyncProjectKeywordPlatformScopeRequestSchema = z
  .object({
    platform_codes: KeywordPlatformScopeSchema,
    project_id: UuidSchema,
  })
  .strict();

export const ProjectKeywordPlatformScopeSyncSchema = z
  .object({
    active_keyword_count: z.number().int().nonnegative(),
    changed_count: z.number().int().nonnegative(),
    matched_count: z.number().int().nonnegative(),
    platform_codes: KeywordPlatformScopeSchema,
    project_id: UuidSchema,
  })
  .strict();

export const KeywordSetIdSchema = UuidSchema;
export const KeywordImportIdSchema = UuidSchema;

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

export const KeywordSetQuerySchema = z
  .object({
    cursor: CursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    project_id: UuidSchema.optional(),
    status: z.enum(['active', 'archived']).optional(),
  })
  .strict();

export const KeywordListQuerySchema = z
  .object({
    cursor: CursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    page: z.coerce.number().int().min(1).max(100_000).optional(),
    platform_code: z.enum(PLATFORM_CODES).optional(),
    search: z.string().trim().min(1).max(240).optional(),
    sort: z.enum(['priority_desc', 'priority_asc']).default('priority_desc'),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .strict()
  .refine((query) => !(query.cursor && query.page), {
    message: 'Cursor and page pagination cannot be combined',
  });

export const KeywordImportPreflightRequestSchema = z
  .object({
    file: z.unknown(),
    sheet_name: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const CommitKeywordImportRequestSchema = z
  .object({
    platform_scope: KeywordPlatformScopeSchema,
    priority: z.number().int().min(0).max(100).default(50),
    selected_page_types: z.array(KeywordSuggestedPageTypeSchema).min(1).max(10),
    selected_source_intents: z.array(KeywordSourceIntentSchema).min(1).max(19),
    status: z.enum(['active', 'disabled']).default('disabled'),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.selected_page_types).size !== value.selected_page_types.length) {
      context.addIssue({
        code: 'custom',
        message: 'Selected page types must be unique',
        path: ['selected_page_types'],
      });
    }
    if (new Set(value.selected_source_intents).size !== value.selected_source_intents.length) {
      context.addIssue({
        code: 'custom',
        message: 'Selected source intents must be unique',
        path: ['selected_source_intents'],
      });
    }
  });

export const KeywordSetViewSchema = z
  .object({
    created_at: IsoDateTimeSchema,
    id: UuidSchema,
    name: z.string().trim().min(1).max(120),
    project_id: UuidSchema,
    status: z.enum(['active', 'archived']),
    tenant_id: UuidSchema,
    updated_at: IsoDateTimeSchema,
  })
  .strict();

export const KeywordSchema = z
  .object({
    created_at: IsoDateTimeSchema,
    id: UuidSchema,
    intents: KeywordIntentsSchema,
    keyword_set_id: UuidSchema,
    platform_scope: KeywordPlatformScopeSchema,
    priority: z.number().int().min(0).max(100),
    status: z.enum(['active', 'disabled']),
    synonyms: KeywordSynonymsSchema,
    tenant_id: UuidSchema,
    term: KeywordTermSchema,
    updated_at: IsoDateTimeSchema,
  })
  .strict();

export const KeywordSetDetailSchema = KeywordSetViewSchema.extend({
  keywords: z.array(KeywordSchema),
}).strict();

export const KeywordSetResponseSchema = z
  .object({ data: KeywordSetViewSchema, meta: RequestMetaSchema })
  .strict();

export const KeywordSetPageSchema = z
  .object({ data: z.array(KeywordSetViewSchema), meta: CursorPageMetaSchema })
  .strict();

export const KeywordSetDetailResponseSchema = z
  .object({ data: KeywordSetDetailSchema, meta: RequestMetaSchema })
  .strict();

export const KeywordListResponseSchema = z
  .object({ data: z.array(KeywordSchema), meta: RequestMetaSchema })
  .strict();

export const ProjectKeywordPlatformScopeSyncResponseSchema = z
  .object({ data: ProjectKeywordPlatformScopeSyncSchema, meta: RequestMetaSchema })
  .strict();

export const KeywordPageSchema = z
  .object({
    data: z.array(KeywordSchema),
    meta: CursorPageMetaSchema.extend({
      page: z.number().int().positive().nullable(),
      page_size: z.number().int().positive(),
      total_count: z.number().int().nonnegative(),
      total_pages: z.number().int().positive(),
    }),
  })
  .strict();

const KeywordImportCountSchema = z
  .object({ count: z.number().int().nonnegative(), label: z.string().trim().min(1).max(80) })
  .strict();

const KeywordImportCandidateSampleSchema = z
  .object({
    intents: KeywordIntentsSchema,
    source_intent: KeywordSourceIntentSchema,
    suggested_page_type: KeywordSuggestedPageTypeSchema,
    synonyms: KeywordSynonymsSchema,
    term: KeywordTermSchema,
  })
  .strict();

export const KeywordImportSummarySchema = z
  .object({
    candidate_samples: z.array(KeywordImportCandidateSampleSchema).max(20),
    page_types: z.array(KeywordImportCountSchema).max(10),
    source_intents: z.array(KeywordImportCountSchema).max(19),
  })
  .strict();

export const KeywordImportJobViewSchema = z
  .object({
    candidate_count: z.number().int().nonnegative(),
    content_hash: z.string().regex(/^[0-9a-f]{64}$/u),
    created_at: IsoDateTimeSchema,
    file_name: z.string().trim().min(1).max(255),
    folded_row_count: z.number().int().nonnegative(),
    id: UuidSchema,
    imported_count: z.number().int().nonnegative(),
    invalid_row_count: z.number().int().nonnegative(),
    keyword_set_id: UuidSchema,
    selected_count: z.number().int().nonnegative(),
    sheet_name: z.string().trim().min(1).max(120),
    status: z.enum(['preflight_ready', 'queued', 'running', 'succeeded', 'failed']),
    summary: KeywordImportSummarySchema,
    tenant_id: UuidSchema,
    total_row_count: z.number().int().nonnegative(),
    updated_at: IsoDateTimeSchema,
    error: z
      .object({
        code: z.string().trim().min(1).max(80),
        message: z.string().trim().min(1).max(2_000),
        schema_version: z.literal('keyword-import-error@1'),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const KeywordImportJobResponseSchema = z
  .object({ data: KeywordImportJobViewSchema, meta: RequestMetaSchema })
  .strict();

export type CreateKeywordSetRequest = z.infer<typeof CreateKeywordSetRequestSchema>;
export type BatchKeywordOperation = z.infer<typeof BatchKeywordOperationSchema>;
export type BatchKeywordOperationRequest = z.infer<typeof BatchKeywordOperationRequestSchema>;
export type CommitKeywordImportRequest = z.infer<typeof CommitKeywordImportRequestSchema>;
export type KeywordInput = z.infer<typeof KeywordInputSchema>;
export type KeywordListQuery = z.infer<typeof KeywordListQuerySchema>;
export type KeywordSourceIntent = z.infer<typeof KeywordSourceIntentSchema>;
export type KeywordSuggestedPageType = z.infer<typeof KeywordSuggestedPageTypeSchema>;
export type KeywordImportJobView = z.infer<typeof KeywordImportJobViewSchema>;
export type KeywordSetQuery = z.infer<typeof KeywordSetQuerySchema>;
export type UpsertKeywordsRequest = z.infer<typeof UpsertKeywordsRequestSchema>;
export type SyncProjectKeywordPlatformScopeRequest = z.infer<
  typeof SyncProjectKeywordPlatformScopeRequestSchema
>;
export type ProjectKeywordPlatformScopeSync = z.infer<typeof ProjectKeywordPlatformScopeSyncSchema>;

export interface KeywordSetView {
  readonly created_at: string;
  readonly id: string;
  readonly name: string;
  readonly project_id: string;
  readonly status: 'active' | 'archived';
  readonly tenant_id: string;
  readonly updated_at: string;
}

export interface Keyword {
  readonly created_at: string;
  readonly id: string;
  readonly intents: readonly ('informational' | 'commercial' | 'transactional' | 'navigational')[];
  readonly keyword_set_id: string;
  readonly platform_scope: readonly (typeof PLATFORM_CODES)[number][];
  readonly priority: number;
  readonly status: 'active' | 'disabled';
  readonly synonyms: readonly string[];
  readonly tenant_id: string;
  readonly term: string;
  readonly updated_at: string;
}

export interface KeywordSetDetail extends KeywordSetView {
  readonly keywords: readonly Keyword[];
}

export interface KeywordSetPage {
  readonly data: readonly KeywordSetView[];
  readonly meta: {
    readonly next_cursor: string | null;
    readonly request_id: string;
  };
}
