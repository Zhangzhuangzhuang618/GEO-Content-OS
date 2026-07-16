import { z } from 'zod';

const UuidSchema = z.string().uuid();

export const AuditEventSchema = z
  .object({
    action: z.string().min(1).max(80),
    actor_id: UuidSchema.nullable(),
    actor_name: z.string().min(1).max(80).nullable(),
    after: z.json().nullable(),
    before: z.json().nullable(),
    created_at: z.string().datetime({ offset: true }),
    id: UuidSchema,
    ip: z.string().min(1).max(64).nullable(),
    request_id: z.string().min(1).max(80),
    resource_id: UuidSchema.nullable(),
    resource_type: z.string().min(1).max(64),
  })
  .strict();

export const AuditPageResponseSchema = z
  .object({
    data: z
      .object({
        items: z.array(AuditEventSchema),
        next_cursor: z.string().nullable(),
      })
      .strict(),
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();

export interface AuditFilters {
  readonly action: string;
  readonly actorId: string;
  readonly from: string;
  readonly requestId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly to: string;
}

export type AuditEvent = z.infer<typeof AuditEventSchema>;
