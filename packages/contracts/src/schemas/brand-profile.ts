import { z } from 'zod';

const NonblankListSchema = (maximumItems: number) =>
  z
    .array(z.string().trim().min(1).max(500))
    .max(maximumItems)
    .refine(
      (values) => new Set(values.map((value) => value.toLowerCase())).size === values.length,
      {
        message: 'Brand profile list values must be unique',
      },
    );

export const BrandProfileSchemaVersionSchema = z.literal('brand-profile@1');

export const BrandProfileSchema = z
  .object({
    audience: NonblankListSchema(50).min(1),
    banned: NonblankListSchema(100),
    compliance: NonblankListSchema(100),
    cta: z.string().trim().min(1).max(500).nullable(),
    differentiators: NonblankListSchema(50),
    positioning: z.string().trim().min(1).max(2_000),
    tone: z.string().trim().min(1).max(240),
  })
  .strict();

export type BrandProfile = z.infer<typeof BrandProfileSchema>;
export type BrandProfileSchemaVersion = z.infer<typeof BrandProfileSchemaVersionSchema>;
