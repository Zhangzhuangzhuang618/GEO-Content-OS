import { z } from 'zod';
export const EditorialContextViewSchema = z
  .object({
    account_id: z.uuid(),
    platform_code: z.enum(['official_site', 'lieju', 'douyin']),
    policy_version: z.number().int().nonnegative(),
    schema_version: z.literal('editorial-context@1'),
    template_version: z.literal('company-recommendation@1'),
    style: z.enum(['standard', 'company_recommendation']),
    companies: z
      .array(
        z
          .object({ id: z.uuid(), legal_name: z.string(), source_document_ids: z.array(z.uuid()) })
          .strict(),
      )
      .max(6),
  })
  .strict();
