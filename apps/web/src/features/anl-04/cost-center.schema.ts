import { z } from 'zod';

const UuidSchema = z.string().uuid();
const CurrencySchema = z.string().regex(/^[A-Z]{3}$/u);
const MetaSchema = z.object({ request_id: z.string().min(1) }).passthrough();

const CostBreakdownItemSchema = z
  .object({
    cost_category: z.string().min(1),
    cost_cents: z.number().int().nonnegative(),
    currency: CurrencySchema,
    entry_count: z.number().int().nonnegative(),
    generation_run_id: UuidSchema.nullable(),
    model_key: z.string().nullable(),
    package_id: UuidSchema.nullable(),
    project_id: UuidSchema.nullable(),
    provider: z.string().nullable(),
    skill_name: z.string().nullable(),
    variant_id: UuidSchema.nullable(),
    workspace_id: UuidSchema.nullable(),
  })
  .strict();

export const CostReportResponseSchema = z
  .object({
    data: z
      .object({
        breakdown: z.array(CostBreakdownItemSchema),
        package_totals: z.array(
          z
            .object({
              cost_cents: z.number().int().nonnegative(),
              currency: CurrencySchema,
              entry_count: z.number().int().nonnegative(),
              package_id: UuidSchema,
            })
            .strict(),
        ),
        settled_only: z.literal(true),
        totals: z.array(
          z
            .object({
              cost_cents: z.number().int().nonnegative(),
              currency: CurrencySchema,
              entry_count: z.number().int().nonnegative(),
            })
            .strict(),
        ),
      })
      .strict(),
    meta: MetaSchema,
  })
  .strict();

export const CostBudgetResponseSchema = z
  .object({
    data: z
      .object({
        consumed_cents: z.number().int().nonnegative(),
        currency: z.literal('CNY'),
        hard_limit: z.boolean(),
        is_exceeded: z.boolean(),
        is_exhausted: z.boolean(),
        limit_cents: z.number().int().nonnegative().nullable(),
        month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u),
        remaining_cents: z.number().int().nonnegative().nullable(),
        workspace_id: UuidSchema,
      })
      .strict(),
    meta: MetaSchema,
  })
  .strict();

const ReconciliationItemSchema = z
  .object({
    billed_cost_cents: z.number().int().nonnegative().nullable(),
    currency: CurrencySchema,
    delta_cents: z.number().int().nullable(),
    ledger_cost_cents: z.number().int().nonnegative(),
    provider: z.string().nullable(),
    status: z.enum(['matched', 'mismatch', 'missing_ledger', 'missing_statement']),
  })
  .strict();

export const ReconciliationResponseSchema = z
  .object({
    data: z
      .object({
        from: z.iso.datetime(),
        items: z.array(ReconciliationItemSchema),
        settled_only: z.literal(true),
        to: z.iso.datetime(),
      })
      .strict(),
    meta: MetaSchema,
  })
  .strict();

export interface CostFilters {
  readonly currency?: string;
  readonly from: string;
  readonly modelKey?: string;
  readonly packageId?: string;
  readonly projectId?: string;
  readonly skillName?: string;
  readonly to: string;
  readonly workspaceId: string;
}

export interface ProviderStatementLine {
  readonly billed_cost_cents: number;
  readonly currency: string;
  readonly provider: string;
}

export type CostReport = z.infer<typeof CostReportResponseSchema>['data'];
export type CostBreakdownItem = z.infer<typeof CostBreakdownItemSchema>;
export type CostBudget = z.infer<typeof CostBudgetResponseSchema>['data'];
export type Reconciliation = z.infer<typeof ReconciliationResponseSchema>['data'];
