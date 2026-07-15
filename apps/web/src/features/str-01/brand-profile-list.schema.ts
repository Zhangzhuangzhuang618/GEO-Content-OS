import { z } from 'zod';

import { BrandProfileViewSchema } from '../str-02/brand-profile.schema';

export const BrandProfilePageSchema = z
  .object({
    data: z.array(BrandProfileViewSchema),
    meta: z
      .object({ next_cursor: z.string().nullable(), request_id: z.string().min(1) })
      .passthrough(),
  })
  .strict();

export type BrandProfileListItem = z.infer<typeof BrandProfileViewSchema>;
export type BrandProfileStatus = BrandProfileListItem['status'];
