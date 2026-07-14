import { z } from 'zod';

export const FactIdSchema = z.string().uuid();

export const VerifyFactRequestSchema = z
  .object({
    decision: z.enum(['verified', 'conflicted', 'retired']),
    expected_updated_at: z.string().datetime({ offset: true }),
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();
