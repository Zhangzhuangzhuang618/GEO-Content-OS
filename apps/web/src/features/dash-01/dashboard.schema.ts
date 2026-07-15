import { z } from 'zod';

export const ProjectSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1),
    status: z.enum(['active', 'archived']),
    workspace_id: z.string().uuid(),
  })
  .passthrough();

export const ProjectPageSchema = z
  .object({
    data: z.array(ProjectSchema),
    meta: z
      .object({ next_cursor: z.string().nullable(), request_id: z.string().min(1) })
      .passthrough(),
  })
  .strict();

export const ContentPackageStatusSchema = z.enum([
  'draft',
  'generating',
  'generated',
  'all_failed',
  'editing',
  'in_review',
  'rejected',
  'approved',
  'scheduled',
  'publishing',
  'publish_failed',
  'published',
  'cancelled',
  'archived',
]);

export const DashboardContentPackageSchema = z
  .object({
    created_at: z.iso.datetime(),
    id: z.string().uuid(),
    project_id: z.string().uuid(),
    status: ContentPackageStatusSchema,
    updated_at: z.iso.datetime(),
    workspace_id: z.string().uuid(),
  })
  .passthrough();

export const ContentPackagePageSchema = z
  .object({
    data: z.array(DashboardContentPackageSchema),
    meta: z
      .object({ next_cursor: z.string().nullable(), request_id: z.string().min(1) })
      .passthrough(),
  })
  .strict();

const CostTotalSchema = z
  .object({
    cost_cents: z.number().int().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    entry_count: z.number().int().nonnegative(),
  })
  .strict();

export const CostBreakdownResponseSchema = z
  .object({
    data: z
      .object({
        breakdown: z.array(z.unknown()),
        package_totals: z.array(z.unknown()),
        settled_only: z.literal(true),
        totals: z.array(CostTotalSchema),
      })
      .strict(),
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();

export type DashboardContentPackage = z.infer<typeof DashboardContentPackageSchema>;
export type DashboardProject = z.infer<typeof ProjectSchema>;

export interface DashboardFilters {
  readonly from: string;
  readonly projectId: string;
  readonly to: string;
  readonly workspaceId: string;
}

export interface DashboardData {
  readonly costCents: number | null;
  readonly packages: readonly DashboardContentPackage[];
}
