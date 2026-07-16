import { z } from 'zod';

import {
  CursorSchema,
  IsoDateTimeSchema,
  UuidSchema,
  createDataResponseSchema,
} from '../common.js';

export const AuditQuerySchema = z
  .object({
    action: z.string().trim().min(1).max(80).optional(),
    actor_id: UuidSchema.optional(),
    cursor: CursorSchema.optional(),
    from: IsoDateTimeSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    request_id: z.string().trim().min(1).max(80).optional(),
    resource_id: UuidSchema.optional(),
    resource_type: z.string().trim().min(1).max(64).optional(),
    to: IsoDateTimeSchema.optional(),
  })
  .strict()
  .refine((value) => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to), {
    message: 'from must not be after to',
    path: ['to'],
  });

export const AuditEventViewSchema = z
  .object({
    action: z.string().min(1).max(80),
    actor_id: UuidSchema.nullable(),
    actor_name: z.string().min(1).max(80).nullable(),
    after: z.json().nullable(),
    before: z.json().nullable(),
    created_at: IsoDateTimeSchema,
    id: UuidSchema,
    ip: z.string().min(1).max(64).nullable(),
    request_id: z.string().min(1).max(80),
    resource_id: UuidSchema.nullable(),
    resource_type: z.string().min(1).max(64),
  })
  .strict();

export const AuditEventPageSchema = z
  .object({
    items: z.array(AuditEventViewSchema),
    next_cursor: CursorSchema.nullable(),
  })
  .strict();

export const AuditEventPageResponseSchema = createDataResponseSchema(AuditEventPageSchema);

export type AuditQuery = z.infer<typeof AuditQuerySchema>;
export type AuditEventView = z.infer<typeof AuditEventViewSchema>;
export type AuditEventPage = z.infer<typeof AuditEventPageSchema>;
