import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';

import { ContentMediaAutomation } from './content-media-automation.js';
import { QualityAutomationCoordinator } from './quality-automation.js';

const PASSED_GATE = Object.freeze({
  blocking_rules: Object.freeze([]),
  brand_consistency: 95,
  factual_accuracy: 95,
  geo_total: 90,
  passed: true,
  platform_fit: 90,
  question_coverage: 90,
  readability_safety: 90,
  schema_version: 'official-site-quality-gate@1' as const,
});
const LIEJU_PASSED_GATE = Object.freeze({
  ...PASSED_GATE,
  platform_code: 'lieju' as const,
  schema_version: 'browser-platform-quality-gate@1' as const,
});

describe('quality automation media handoff', () => {
  it('enqueues media only after the frozen quality gate passes', async () => {
    const enqueue = vi.fn(async () => undefined);
    const media = new ContentMediaAutomation(
      {
        enabled: true,
        generationSteps: 4,
        plannerModelKey: 'deepseek-v4-flash',
        publicBaseUrl: null,
      },
      { generationModel: null, inspectionModel: null, provider: null },
    );
    media.enqueue = enqueue;
    const officialAdvance = vi.fn(async () => undefined);
    const coordinator = new QualityAutomationCoordinator(
      { advanceAfterQuality: officialAdvance } as never,
      {} as never,
      media,
    );

    await coordinator.advanceAfterQuality(
      {} as never,
      {} as never,
      { kind: 'official_site', value: {} as never },
      'report-id',
      PASSED_GATE,
      {} as never,
    );

    expect(enqueue).toHaveBeenCalledOnce();
    expect(officialAdvance).not.toHaveBeenCalled();
  });

  it('emits the concrete Sohu platform code for browser-platform media work', async () => {
    const payloads: string[] = [];
    const transaction = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join('?');
      if (query.includes('INSERT INTO content_media_runs'))
        return [{ id: crypto.randomUUID(), status: 'queued' }];
      if (query.includes('UPDATE browser_platform_automation_runs'))
        return [{ id: crypto.randomUUID() }];
      if (query.includes('UPDATE browser_platform_daily_batch_items')) return [];
      if (query.includes('INSERT INTO outbox_events')) {
        payloads.push(
          values.find(
            (value) =>
              typeof value === 'string' &&
              value.startsWith('{') &&
              value.includes('media_generation_requested'),
          ) as string,
        );
        return [];
      }
      throw new Error(`Unexpected SQL: ${query}`);
    }) as unknown as postgres.TransactionSql;
    const media = new ContentMediaAutomation(
      {
        enabled: true,
        generationSteps: 4,
        plannerModelKey: 'deepseek-v4-flash',
        publicBaseUrl: null,
      },
      { generationModel: null, inspectionModel: null, provider: null },
    );
    const id = () => crypto.randomUUID();

    await media.enqueue(
      transaction,
      {
        data: {
          actorUserId: id(),
          contentHash: 'a'.repeat(64),
          contentVersionId: id(),
          generationRunId: id(),
          packageId: id(),
          projectId: id(),
          requestId: 'sohu-media-handoff',
          variantId: id(),
          workspaceId: id(),
        },
        eventId: id(),
        tenantId: id(),
      },
      { kind: 'browser_platform', value: { id: id(), platformCode: 'sohu' } as never },
      id(),
    );

    expect(JSON.parse(payloads[0]!).data.platform_code).toBe('sohu');
  });

  it('skips Lieju media generation when no public media base URL is configured', async () => {
    const enqueue = vi.fn(async () => undefined);
    const media = new ContentMediaAutomation(
      {
        enabled: true,
        generationSteps: 4,
        plannerModelKey: 'deepseek-v4-flash',
        publicBaseUrl: null,
      },
      { generationModel: null, inspectionModel: null, provider: null },
    );
    media.enqueue = enqueue;
    const browserAdvance = vi.fn(async () => undefined);
    const coordinator = new QualityAutomationCoordinator({} as never, {} as never, media, {
      advanceAfterQuality: browserAdvance,
    } as never);

    await coordinator.advanceAfterQuality(
      {} as never,
      {} as never,
      { kind: 'browser_platform', value: { platformCode: 'lieju' } as never },
      'report-id',
      LIEJU_PASSED_GATE,
      {} as never,
    );

    expect(enqueue).not.toHaveBeenCalled();
    expect(browserAdvance).toHaveBeenCalledOnce();
  });

  it('keeps Lieju media generation when a public media base URL is configured', () => {
    const media = new ContentMediaAutomation(
      {
        enabled: true,
        generationSteps: 4,
        plannerModelKey: 'deepseek-v4-flash',
        publicBaseUrl: 'https://media.example.com',
      },
      { generationModel: null, inspectionModel: null, provider: null },
    );

    expect(
      media.shouldEnqueue(LIEJU_PASSED_GATE, {
        kind: 'browser_platform',
        value: { platformCode: 'lieju' } as never,
      }),
    ).toBe(true);
  });

  it('keeps Sohu media generation without a public media base URL', () => {
    const media = new ContentMediaAutomation(
      {
        enabled: true,
        generationSteps: 4,
        plannerModelKey: 'deepseek-v4-flash',
        publicBaseUrl: null,
      },
      { generationModel: null, inspectionModel: null, provider: null },
    );

    expect(
      media.shouldEnqueue(
        { ...LIEJU_PASSED_GATE, platform_code: 'sohu' },
        {
          kind: 'browser_platform',
          value: { platformCode: 'sohu' } as never,
        },
      ),
    ).toBe(true);
  });

  it('keeps failed quality gates on the existing rewrite or block path', async () => {
    const enqueue = vi.fn(async () => undefined);
    const media = new ContentMediaAutomation(
      {
        enabled: true,
        generationSteps: 4,
        plannerModelKey: 'deepseek-v4-flash',
        publicBaseUrl: null,
      },
      { generationModel: null, inspectionModel: null, provider: null },
    );
    media.enqueue = enqueue;
    const officialAdvance = vi.fn(async () => undefined);
    const coordinator = new QualityAutomationCoordinator(
      { advanceAfterQuality: officialAdvance } as never,
      {} as never,
      media,
    );

    await coordinator.advanceAfterQuality(
      {} as never,
      {} as never,
      { kind: 'official_site', value: {} as never },
      'report-id',
      { ...PASSED_GATE, blocking_rules: ['gate.geo_total'], passed: false },
      {} as never,
    );

    expect(enqueue).not.toHaveBeenCalled();
    expect(officialAdvance).toHaveBeenCalledOnce();
  });
});
