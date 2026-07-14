import { z } from 'zod';

import { ERROR_CODES } from '../errors.js';

export const UuidSchema = z.string().uuid();
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const UlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
export const RequestIdSchema = z.union([
  UuidSchema,
  UlidSchema,
  z
    .string()
    .min(16)
    .max(80)
    .regex(/^[A-Za-z0-9._:-]+$/u),
]);

export const VersionSchema = z.number().int().positive();
export const CursorSchema = z.string().min(1).max(512);
export const IdempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const CursorPageQuerySchema = z
  .object({
    cursor: CursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const ReasonRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const RequestMetaSchema = z
  .object({
    request_id: RequestIdSchema,
  })
  .strict();

export const CursorPageMetaSchema = RequestMetaSchema.extend({
  next_cursor: CursorSchema.nullable(),
});

export const ErrorCodeSchema = z.enum(ERROR_CODES);

export const ApiErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: ErrorCodeSchema,
        message: z.string().min(1),
        details: z.unknown().optional(),
        request_id: RequestIdSchema,
      })
      .strict(),
  })
  .strict();

export function createDataResponseSchema<TSchema extends z.ZodType>(dataSchema: TSchema) {
  return z
    .object({
      data: dataSchema,
      meta: RequestMetaSchema,
    })
    .strict();
}

export type CursorPageQuery = z.infer<typeof CursorPageQuerySchema>;
export type ReasonRequest = z.infer<typeof ReasonRequestSchema>;
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
