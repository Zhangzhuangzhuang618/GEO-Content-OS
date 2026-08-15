import { describe, expect, it } from 'vitest';

import { GenerationWorkerError } from './generation.errors.js';
import { validateBrowserPlatformRewriteEvent } from './browser-platform-rewrite.event.js';

const VARIANT_ID = '70000000-0000-4000-8000-000000000153';
const EVENT = {
  aggregate: { id: VARIANT_ID, type: 'content_variant' },
  data: {
    actor_user_id: '10000000-0000-4000-8000-000000000153',
    automation_run_id: 'a0000000-0000-4000-8000-000000000153',
    content_version_id: '80000000-0000-4000-8000-000000000153',
    generation_run_id: '90000000-0000-4000-8000-000000000153',
    package_id: '60000000-0000-4000-8000-000000000153',
    platform_code: 'lieju',
    project_id: '40000000-0000-4000-8000-000000000153',
    request_id: 'lieju-rewrite-153',
    rewrite_attempt: 1,
    variant_id: VARIANT_ID,
    workspace_id: '30000000-0000-4000-8000-000000000153',
  },
  event_id: 'b0000000-0000-4000-8000-000000000153',
  event_type: 'content.variant.browser_platform_rewrite_requested.v1',
  occurred_at: '2026-08-16T00:00:00.000Z',
  tenant: { id: '20000000-0000-4000-8000-000000000153' },
} as const;

describe('browser-platform rewrite event validation', () => {
  it('normalizes Lieju and Sohu rewrite events', () => {
    expect(validateBrowserPlatformRewriteEvent(EVENT)).toMatchObject({
      data: { platformCode: 'lieju', rewriteAttempt: 1, variantId: VARIANT_ID },
      eventId: EVENT.event_id,
      tenantId: EVENT.tenant.id,
    });
    expect(
      validateBrowserPlatformRewriteEvent({
        ...EVENT,
        data: { ...EVENT.data, platform_code: 'sohu', rewrite_attempt: 3 },
      }).data,
    ).toMatchObject({ platformCode: 'sohu', rewriteAttempt: 3 });
  });

  it('rejects other platforms, stale aggregate ids and attempts above the frozen maximum', () => {
    expect(() =>
      validateBrowserPlatformRewriteEvent({
        ...EVENT,
        data: { ...EVENT.data, platform_code: 'baijiahao' },
      }),
    ).toThrow(GenerationWorkerError);
    expect(() =>
      validateBrowserPlatformRewriteEvent({
        ...EVENT,
        aggregate: { ...EVENT.aggregate, id: crypto.randomUUID() },
      }),
    ).toThrow('Browser platform rewrite event is invalid');
    expect(() =>
      validateBrowserPlatformRewriteEvent({
        ...EVENT,
        data: { ...EVENT.data, rewrite_attempt: 4 },
      }),
    ).toThrow('Browser platform rewrite event is invalid');
    expect(() =>
      validateBrowserPlatformRewriteEvent({
        ...EVENT,
        data: { ...EVENT.data, tenant_id: EVENT.tenant.id },
      }),
    ).toThrow('Browser platform rewrite event is invalid');
  });
});
