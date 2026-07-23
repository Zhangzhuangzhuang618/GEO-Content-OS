import { z } from 'zod';

import { ToutiaoPayloadSchema } from '../../render/src/schema.js';

export const ToutiaoDeliveryInputSchema = z
  .object({
    content_version_id: z.string().uuid(),
    idempotency_key: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
    payload: ToutiaoPayloadSchema,
    payload_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export const ToutiaoCapabilityResponseSchema = z
  .object({ get_status: z.boolean(), metrics: z.boolean(), publish: z.boolean() })
  .strict();

export const ToutiaoPublishResponseSchema = z
  .object({
    external_id: z.string().trim().min(1).max(240),
    status: z.enum(['processing', 'published']),
    url: z.url().nullable(),
  })
  .strict();

export const ToutiaoStatusResponseSchema = z
  .object({
    external_id: z.string().trim().min(1).max(240),
    status: z.enum(['failed', 'processing', 'published', 'unknown']),
    url: z.url().nullable(),
  })
  .strict();

export const ToutiaoMetricsResponseSchema = z
  .object({
    external_id: z.string().trim().min(1).max(240),
    measured_at: z.iso.datetime(),
    metrics: z.record(z.string().trim().min(1).max(80), z.number().finite().nonnegative()),
  })
  .strict();
