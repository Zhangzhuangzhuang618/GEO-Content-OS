import { z } from 'zod';

import { LiejuPayloadSchema } from '../../render/src/schema.js';

export const LiejuDeliveryInputSchema = z
  .object({
    content_version_id: z.string().uuid(),
    image_urls: z
      .array(z.url().refine((value) => value.startsWith('https://')))
      .max(5)
      .optional(),
    idempotency_key: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
    payload: LiejuPayloadSchema,
    payload_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export const LiejuCapabilityResponseSchema = z
  .object({
    get_status: z.boolean(),
    metrics: z.boolean(),
    publish: z.boolean(),
  })
  .strict();

export const LiejuPublishResponseSchema = z
  .object({
    external_id: z.string().trim().min(1).max(240),
    response_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    status: z.enum(['processing', 'published']),
    url: z.url().nullable(),
  })
  .strict();

export const LiejuStatusResponseSchema = z
  .object({
    external_id: z.string().trim().min(1).max(240),
    status: z.enum(['failed', 'processing', 'published', 'unknown']),
    url: z.url().nullable(),
  })
  .strict();

export const LiejuMetricsResponseSchema = z
  .object({
    external_id: z.string().trim().min(1).max(240),
    measured_at: z.iso.datetime(),
    metrics: z.record(z.string().trim().min(1).max(80), z.number().finite().nonnegative()),
  })
  .strict();
