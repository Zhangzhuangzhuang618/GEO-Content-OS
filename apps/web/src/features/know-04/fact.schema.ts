import { z } from 'zod';

export const FactStatusSchema = z.enum(['candidate', 'verified', 'conflicted', 'retired']);

const EvidenceSchema = z
  .object({
    chunk_id: z.string().uuid(),
    created_at: z.iso.datetime(),
    id: z.string().uuid(),
    quote_hash: z.string().regex(/^[0-9a-f]{64}$/u),
    quote_text: z.string().min(1),
    source_document_id: z.string().uuid(),
  })
  .strict();

export const FactSchema = z
  .object({
    confidence: z.number().min(0).max(1),
    created_at: z.iso.datetime(),
    evidence: z.array(EvidenceSchema).optional(),
    id: z.string().uuid(),
    object_value: z.string().min(1),
    predicate: z.string().min(1).max(120),
    status: FactStatusSchema,
    subject: z.string().min(1).max(240),
    tenant_id: z.string().uuid(),
    unit: z.string().min(1).max(32).nullable(),
    updated_at: z.iso.datetime(),
    valid_from: z.string().date().nullable(),
    valid_to: z.string().date().nullable(),
    workspace_id: z.string().uuid(),
  })
  .strict();

export const FactPageSchema = z
  .object({
    data: z.array(FactSchema),
    meta: z
      .object({ next_cursor: z.string().nullable(), request_id: z.string().min(1) })
      .passthrough(),
  })
  .strict();

export const FactResponseSchema = z
  .object({
    data: FactSchema,
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();

export type Fact = z.infer<typeof FactSchema>;
export type FactStatus = z.infer<typeof FactStatusSchema>;
export type FactDecision = Exclude<FactStatus, 'candidate'>;
