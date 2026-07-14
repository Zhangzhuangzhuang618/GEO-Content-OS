import { z } from 'zod';

import { BrandProfileSchema, BrandProfileSchemaVersionSchema } from '../schemas/index.js';
import { CursorSchema, UuidSchema } from './common.js';

export const CreateBrandProfileRequestSchema = z
  .object({
    profile: BrandProfileSchema,
    schema_version: BrandProfileSchemaVersionSchema.default('brand-profile@1'),
    workspace_id: UuidSchema,
  })
  .strict();

export const PublishVersionRequestSchema = z
  .object({
    version: z.number().int().positive(),
  })
  .strict();

export const BrandProfileQuerySchema = z
  .object({
    cursor: CursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z.enum(['draft', 'published', 'retired']).optional(),
    workspace_id: UuidSchema.optional(),
  })
  .strict();

export const BrandProfileIdSchema = UuidSchema;

export type CreateBrandProfileRequest = z.infer<typeof CreateBrandProfileRequestSchema>;
export type PublishVersionRequest = z.infer<typeof PublishVersionRequestSchema>;
export type BrandProfileQuery = z.infer<typeof BrandProfileQuerySchema>;

export interface BrandProfileView {
  readonly created_at: string;
  readonly created_by: string;
  readonly id: string;
  readonly profile: z.infer<typeof BrandProfileSchema>;
  readonly published_at: string | null;
  readonly schema_version: z.infer<typeof BrandProfileSchemaVersionSchema>;
  readonly status: 'draft' | 'published' | 'retired';
  readonly tenant_id: string;
  readonly version: number;
  readonly workspace_id: string;
}

export interface BrandProfilePage {
  readonly data: readonly BrandProfileView[];
  readonly meta: {
    readonly next_cursor: string | null;
    readonly request_id: string;
  };
}
