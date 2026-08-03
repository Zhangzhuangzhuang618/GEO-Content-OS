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
const KeywordIntentSchema = z.enum([
  'informational',
  'commercial',
  'transactional',
  'navigational',
]);

const KeywordIntentsSchema = z
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

const KeywordPlatformScopeSchema = z
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

export const KeywordSetIdSchema = UuidSchema;

export const KeywordSetQuerySchema = z
  .object({
    cursor: CursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    project_id: UuidSchema.optional(),
    status: z.enum(['active', 'archived']).optional(),
  })
  .strict();

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

export type CreateKeywordSetRequest = z.infer<typeof CreateKeywordSetRequestSchema>;
export type KeywordInput = z.infer<typeof KeywordInputSchema>;
export type KeywordSetQuery = z.infer<typeof KeywordSetQuerySchema>;
export type UpsertKeywordsRequest = z.infer<typeof UpsertKeywordsRequestSchema>;

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
