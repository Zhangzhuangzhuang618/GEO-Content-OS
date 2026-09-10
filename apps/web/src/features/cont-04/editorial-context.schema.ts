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
          .object({
            id: z.uuid(),
            legal_name: z.string(),
            source_document_ids: z.array(z.uuid()),
            evidence_mode: z
              .enum(['documents', 'primary', 'inherit_primary', 'description'])
              .optional(),
            business_description: z.string().optional(),
            description_source_id: z.uuid().optional(),
          })
          .strict(),
      )
      .max(6),
    evidence_resolved: z.boolean().optional(),
    primary_company_name: z.string().optional(),
  })
  .strict();
