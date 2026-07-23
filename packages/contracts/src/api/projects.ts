import { z } from 'zod';

import {
  CursorPageMetaSchema,
  CursorSchema,
  IsoDateTimeSchema,
  RequestMetaSchema,
  UuidSchema,
  VersionSchema,
} from './common.js';

const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine(isCalendarDate, { message: 'Date must be a valid ISO calendar date' });

const ProjectFieldsSchema = z.object({
  end_date: IsoDateSchema.nullable().optional(),
  name: z.string().trim().min(1).max(160),
  objective: z.string().trim().min(1).max(10_000).nullable().optional(),
  owner_id: UuidSchema,
  start_date: IsoDateSchema.nullable().optional(),
  workspace_id: UuidSchema,
});

export const CreateProjectRequestSchema =
  ProjectFieldsSchema.strict().superRefine(validateDateRange);

export const UpdateProjectRequestSchema = z
  .object({
    end_date: IsoDateSchema.nullable().optional(),
    name: z.string().trim().min(1).max(160).optional(),
    objective: z.string().trim().min(1).max(10_000).nullable().optional(),
    owner_id: UuidSchema.optional(),
    start_date: IsoDateSchema.nullable().optional(),
    status: z.enum(['active', 'archived']).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value).length === 0) {
      context.addIssue({ code: 'custom', message: 'At least one project field is required' });
    }
    if (value.status === 'archived' && Object.keys(value).length !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'Project archival must be submitted as a standalone transition',
        path: ['status'],
      });
    }
    validateDateRange(value, context);
  });

export const ProjectListQuerySchema = z
  .object({
    cursor: CursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    owner_id: UuidSchema.optional(),
    search: z.string().trim().min(1).max(160).optional(),
    status: z.enum(['active', 'archived']).optional(),
    workspace_id: UuidSchema.optional(),
  })
  .strict();

export const ProjectIdSchema = UuidSchema;

export const ProjectViewSchema = z
  .object({
    created_at: IsoDateTimeSchema,
    end_date: IsoDateSchema.nullable(),
    id: UuidSchema,
    name: z.string().min(1).max(160),
    objective: z.string().min(1).max(10_000).nullable(),
    owner_id: UuidSchema,
    start_date: IsoDateSchema.nullable(),
    status: z.enum(['active', 'archived']),
    tenant_id: UuidSchema,
    updated_at: IsoDateTimeSchema,
    version: VersionSchema,
    workspace_id: UuidSchema,
  })
  .strict();

export const ProjectResponseSchema = z
  .object({ data: ProjectViewSchema, meta: RequestMetaSchema })
  .strict();

export const ProjectPageSchema = z
  .object({ data: z.array(ProjectViewSchema), meta: CursorPageMetaSchema })
  .strict();

export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;
export type ProjectListQuery = z.infer<typeof ProjectListQuerySchema>;

export type ProjectView = z.infer<typeof ProjectViewSchema>;
export type ProjectPage = z.infer<typeof ProjectPageSchema>;

function validateDateRange(
  value: {
    readonly end_date?: string | null | undefined;
    readonly start_date?: string | null | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (value.start_date && value.end_date && value.end_date < value.start_date) {
    context.addIssue({
      code: 'custom',
      message: 'Project end date must be on or after its start date',
      path: ['end_date'],
    });
  }
}

function isCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
