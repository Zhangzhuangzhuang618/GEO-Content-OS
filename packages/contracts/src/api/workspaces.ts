import { z } from 'zod';

import { PLATFORM_CODES } from '../platforms.js';
import {
  CursorPageMetaSchema,
  CursorSchema,
  IsoDateTimeSchema,
  RequestMetaSchema,
  UuidSchema,
  VersionSchema,
} from './common.js';

export const WorkspaceSettingsSchema = z
  .object({
    schema_version: z.literal('workspace-settings@1'),
    default_platform_codes: z
      .array(z.enum(PLATFORM_CODES))
      .min(1)
      .max(8)
      .refine((values) => new Set(values).size === values.length, {
        message: 'Default workspace platforms must be unique',
      })
      .optional(),
    review_policy: z
      .object({
        minimum_approvals: z.number().int().min(1).max(5),
        require_high_risk_signoff: z.boolean(),
      })
      .strict()
      .optional(),
    budget_policy: z
      .object({
        hard_limit: z.boolean(),
        monthly_limit_cny: z.number().finite().nonnegative().max(1_000_000_000).nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const WorkspaceSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

export const WorkspaceTimezoneSchema = z.string().trim().min(1).max(64);

export const CreateWorkspaceRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    settings: WorkspaceSettingsSchema.default({ schema_version: 'workspace-settings@1' }),
    slug: WorkspaceSlugSchema,
    timezone: WorkspaceTimezoneSchema,
  })
  .strict();

export const UpdateWorkspaceRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    settings: WorkspaceSettingsSchema.optional(),
    slug: WorkspaceSlugSchema.optional(),
    timezone: WorkspaceTimezoneSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one workspace field is required',
  });

export const WorkspaceListQuerySchema = z
  .object({
    cursor: CursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().min(1).max(120).optional(),
    status: z.enum(['active', 'archived']).optional(),
  })
  .strict();

export const WorkspaceIdSchema = UuidSchema;

export const WorkspaceViewSchema = z
  .object({
    created_at: IsoDateTimeSchema,
    id: UuidSchema,
    name: z.string().min(1).max(120),
    settings: WorkspaceSettingsSchema,
    slug: WorkspaceSlugSchema,
    status: z.enum(['active', 'archived']),
    tenant_id: UuidSchema,
    timezone: WorkspaceTimezoneSchema,
    updated_at: IsoDateTimeSchema,
    version: VersionSchema,
  })
  .strict();

export const WorkspaceResponseSchema = z
  .object({ data: WorkspaceViewSchema, meta: RequestMetaSchema })
  .strict();

export const WorkspacePageSchema = z
  .object({ data: z.array(WorkspaceViewSchema), meta: CursorPageMetaSchema })
  .strict();

export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;
export type UpdateWorkspaceRequest = z.infer<typeof UpdateWorkspaceRequestSchema>;
export type WorkspaceListQuery = z.infer<typeof WorkspaceListQuerySchema>;

export type WorkspaceView = z.infer<typeof WorkspaceViewSchema>;
export type WorkspacePage = z.infer<typeof WorkspacePageSchema>;
