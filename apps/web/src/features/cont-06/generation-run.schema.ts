import { z } from 'zod';

import { GenerationRunSchema } from '../cont-04/content-package-detail.schema';

export const GenerationRunResponseSchema = z
  .object({
    data: GenerationRunSchema,
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();

const CostItemSchema = z
  .object({
    cost_category: z.string().min(1),
    cost_cents: z.number().int().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    entry_count: z.number().int().nonnegative(),
    generation_run_id: z.string().uuid().nullable(),
    model_key: z.string().nullable(),
    package_id: z.string().uuid().nullable(),
    project_id: z.string().uuid().nullable(),
    provider: z.string().nullable(),
    skill_name: z.string().nullable(),
    variant_id: z.string().uuid().nullable(),
    workspace_id: z.string().uuid().nullable(),
  })
  .strict();

export const RunCostResponseSchema = z
  .object({
    data: z
      .object({
        breakdown: z.array(CostItemSchema),
        package_totals: z.array(z.unknown()),
        settled_only: z.literal(true),
        totals: z.array(
          z
            .object({
              cost_cents: z.number().int().nonnegative(),
              currency: z.string().regex(/^[A-Z]{3}$/u),
              entry_count: z.number().int().nonnegative(),
            })
            .strict(),
        ),
      })
      .strict(),
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();

export type GenerationRun = z.infer<typeof GenerationRunSchema>;
export type RunCosts = z.infer<typeof RunCostResponseSchema>['data'];
