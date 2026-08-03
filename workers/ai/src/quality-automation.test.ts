import { describe, expect, it, vi } from 'vitest';

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
