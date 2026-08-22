import { describe, expect, it } from 'vitest';

import {
  ApiErrorResponseSchema,
  API_BASE_PATH,
  CONTENT_PACKAGE_STATUSES,
  CONTENT_VARIANT_STATUSES,
  CONTRACT_VERSION,
  DomainEventEnvelopeSchema,
  ERROR_CODES,
  ERROR_DEFINITIONS,
  EVENT_TYPES,
  IdempotencyKeySchema,
  PLATFORM_CODES,
  PLATFORM_DEFINITIONS,
  PLATFORM_ROLE_CODES,
  RequestIdSchema,
  ROLE_DEFINITIONS,
  TENANT_ROLE_CODES,
  createDataResponseSchema,
  isErrorCode,
} from './index.js';

const uuid = '0b44bf0c-8c9a-44b9-9a19-a1812f5695fb';
const requestId = '01J00000000000000000000000';

describe('frozen enums', () => {
  it('keeps all nine supported platforms and definitions aligned', () => {
    expect(PLATFORM_CODES).toHaveLength(9);
    expect(Object.keys(PLATFORM_DEFINITIONS)).toEqual(PLATFORM_CODES);
    expect(new Set(PLATFORM_CODES).size).toBe(PLATFORM_CODES.length);
    expect(Object.isFrozen(PLATFORM_CODES)).toBe(true);
  });

  it('keeps platform and tenant roles complete and non-overlapping', () => {
    expect(PLATFORM_ROLE_CODES).toEqual(['platform_admin', 'platform_operator']);
    expect(TENANT_ROLE_CODES).toEqual([
      'tenant_owner',
      'tenant_admin',
      'strategy_editor',
      'content_editor',
      'reviewer',
      'publisher',
      'analyst',
      'viewer',
    ]);
    expect(Object.keys(ROLE_DEFINITIONS)).toHaveLength(10);
    expect(
      PLATFORM_ROLE_CODES.some((role) => (TENANT_ROLE_CODES as readonly string[]).includes(role)),
    ).toBe(false);
  });

  it('keeps package and variant states frozen', () => {
    expect(CONTENT_PACKAGE_STATUSES).toEqual([
      'draft',
      'generating',
      'generated',
      'all_failed',
      'editing',
      'in_review',
      'rejected',
      'approved',
      'scheduled',
      'publishing',
      'publish_failed',
      'published',
      'cancelled',
      'archived',
    ]);
    expect(CONTENT_VARIANT_STATUSES).toEqual([
      'draft',
      'generating',
      'generation_failed',
      'generated',
      'quality_failed',
      'quality_passed',
      'in_review',
      'review_approved',
      'review_rejected',
      'approved',
      'scheduled',
      'publishing',
      'published',
      'publish_failed',
      'cancelled',
    ]);
    expect(Object.isFrozen(CONTENT_PACKAGE_STATUSES)).toBe(true);
  });

  it('exposes the frozen API and contract versions', () => {
    expect(API_BASE_PATH).toBe('/api/v1');
    expect(CONTRACT_VERSION).toBe('1.0.0');
  });
});

describe('error contracts', () => {
  it('exposes all frozen error codes and HTTP statuses', () => {
    expect(ERROR_CODES).toEqual([
      'AUTH_REQUIRED',
      'CSRF_INVALID',
      'TENANT_CONTEXT_REQUIRED',
      'RESOURCE_NOT_FOUND',
      'PERMISSION_DENIED',
      'STATE_TRANSITION_INVALID',
      'VERSION_CONFLICT',
      'IDEMPOTENCY_CONFLICT',
      'QUALITY_BLOCKED',
      'BUDGET_EXCEEDED',
      'SCHEMA_VALIDATION_FAILED',
      'ADAPTER_CAPABILITY_UNAVAILABLE',
      'ADAPTER_AUTH_EXPIRED',
      'BROWSER_GATEWAY_UNAVAILABLE',
      'RATE_LIMITED',
      'AI_PROVIDER_TIMEOUT',
    ]);
    expect(Object.keys(ERROR_DEFINITIONS)).toEqual(ERROR_CODES);
    expect(ERROR_DEFINITIONS.RESOURCE_NOT_FOUND.httpStatus).toBe(404);
    expect(ERROR_DEFINITIONS.PERMISSION_DENIED.httpStatus).toBe(403);
    expect(ERROR_DEFINITIONS.BROWSER_GATEWAY_UNAVAILABLE.httpStatus).toBe(503);
    expect(ERROR_DEFINITIONS.AI_PROVIDER_TIMEOUT.httpStatus).toBe(504);
    expect(isErrorCode('VERSION_CONFLICT')).toBe(true);
    expect(isErrorCode('UNKNOWN')).toBe(false);
  });

  it('validates the frozen error response envelope strictly', () => {
    const result = ApiErrorResponseSchema.safeParse({
      error: {
        code: 'RESOURCE_NOT_FOUND',
        message: 'not found',
        request_id: requestId,
      },
    });
    expect(result.success).toBe(true);
    expect(
      ApiErrorResponseSchema.safeParse({
        error: {
          code: 'UNKNOWN',
          message: 'bad',
          request_id: requestId,
        },
      }).success,
    ).toBe(false);
  });
});

describe('API DTO foundations', () => {
  it('accepts UUID, ULID, or safe 16-80 character request IDs', () => {
    expect(RequestIdSchema.safeParse(uuid).success).toBe(true);
    expect(RequestIdSchema.safeParse(requestId).success).toBe(true);
    expect(RequestIdSchema.safeParse('client-request-123').success).toBe(true);
    expect(RequestIdSchema.safeParse('request-1').success).toBe(false);
  });

  it('validates successful response envelopes and rejects extra fields', () => {
    const schema = createDataResponseSchema(IdempotencyKeySchema);
    expect(
      schema.safeParse({ data: 'request:key-001', meta: { request_id: requestId } }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        data: 'request:key-001',
        meta: { request_id: requestId },
        unexpected: true,
      }).success,
    ).toBe(false);
  });
});

describe('domain event foundations', () => {
  it('keeps versioned event names below the database limit', () => {
    expect(EVENT_TYPES.every((eventType) => eventType.length <= 80)).toBe(true);
    expect(
      EVENT_TYPES.every((eventType) =>
        /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v[1-9]\d*$/.test(eventType),
      ),
    ).toBe(true);
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });

  it('validates the outbox payload envelope', () => {
    expect(
      DomainEventEnvelopeSchema.safeParse({
        event_id: uuid,
        event_type: 'content.package.generation_requested.v1',
        tenant: { id: uuid },
        aggregate: { type: 'content_package', id: uuid },
        data: { requested_by: uuid },
        occurred_at: '2026-07-14T01:00:00+08:00',
      }).success,
    ).toBe(true);

    expect(
      DomainEventEnvelopeSchema.safeParse({
        event_id: uuid,
        event_type: 'content.unknown.v1',
        tenant: { id: uuid },
        aggregate: { type: 'content_package', id: uuid },
        data: {},
        occurred_at: '2026-07-14T01:00:00+08:00',
      }).success,
    ).toBe(false);

    expect(
      DomainEventEnvelopeSchema.safeParse({
        event_id: uuid,
        event_type: 'content.package.generation_requested.v1',
        tenant: { id: uuid },
        aggregate: { type: 'content_package', id: uuid },
        occurred_at: '2026-07-14T01:00:00+08:00',
      }).success,
    ).toBe(false);
  });
});
