import { z } from 'zod';

import { OfficialSitePayloadSchema } from '../../render/src/schema.js';
import { ZHIYUAN_NEWS_PAYLOAD_SCHEMA_VERSION } from './types.js';

export const OfficialSiteApiPayloadSchema = z
  .object({
    body_html: z.string().min(1).max(500_000),
    meta_description: z.string().trim().min(1).max(240),
    platform_code: z.literal('official_site'),
    schema_version: z.literal(ZHIYUAN_NEWS_PAYLOAD_SCHEMA_VERSION),
    seo_keywords: z.array(z.string().trim().min(1).max(40)).max(20).refine(unique),
    summary: z.string().trim().min(1).max(240),
    title: unicodeText(20, 60),
  })
  .strict();

export const OfficialSiteDeliveryInputSchema = z
  .object({
    content_version_id: z.string().uuid(),
    idempotency_key: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
    payload: OfficialSitePayloadSchema,
    payload_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export const OfficialSiteCapabilityResponseSchema = z
  .object({
    get_status: z.boolean(),
    metrics: z.boolean(),
    publish: z.boolean(),
  })
  .strict();

export const OfficialSitePublishResponseSchema = z
  .object({
    external_id: z.string().trim().min(1).max(240),
    published_at: z.iso.datetime({ offset: true }),
    status: z.enum(['processing', 'published']),
    url: z.url().nullable(),
  })
  .strict();

export const OfficialSiteStatusResponseSchema = z
  .object({
    external_id: z.string().trim().min(1).max(240),
    published_at: z.iso.datetime({ offset: true }),
    status: z.enum(['failed', 'processing', 'published', 'unknown']),
    url: z.url().nullable(),
  })
  .strict();

function unique(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length;
}

function unicodeText(minimum: number, maximum: number) {
  return z.string().refine((value) => {
    const length = [...value].length;
    return length >= minimum && length <= maximum;
  }, `Text must contain ${minimum}-${maximum} Unicode characters`);
}

export const OfficialSiteMetricsResponseSchema = z
  .object({
    external_id: z.string().trim().min(1).max(240),
    measured_at: z.iso.datetime({ offset: true }),
    metrics: z.record(z.string().trim().min(1).max(80), z.number().finite().nonnegative()),
  })
  .strict();
