import type { QualityCheckerData } from '@geo-content-os/contracts/skills';
import { describe, expect, it } from 'vitest';

import {
  BrowserPlatformAutomation,
  type BrowserPlatformAutomationPolicy,
  nextSchedule,
} from './browser-platform-automation.js';

describe('browser-platform automation', () => {
  it('enforces every frozen quality threshold and BLOCK issue', () => {
    const automation = new BrowserPlatformAutomation(null as never, null as never, {} as never);
    const result: QualityCheckerData = {
      decision: 'pass',
      geo_scores: {
        answerability: 90,
        entity: 90,
        evidence: 89,
        platform_fit: 79,
        question: 79,
        readability_safety: 84,
        total: 84,
      },
      issues: [
        {
          category: 'brand',
          citation_ids: [],
          location: 'blocks.service',
          message: '企业名称不一致。',
          rule_id: 'brand.name_mismatch',
          severity: 'BLOCK',
          suggestion: '使用已发布企业名称。',
        },
      ],
      score: 84,
    };

    const gate = automation.calculateGate(policy(), result, result.geo_scores);

    expect(gate.passed).toBe(false);
    expect(gate.blocking_rules).toEqual(
      expect.arrayContaining([
        'brand.name_mismatch',
        'gate.brand_consistency',
        'gate.factual_accuracy',
        'gate.geo_total',
        'gate.platform_fit',
        'gate.question_coverage',
        'gate.readability_safety',
      ]),
    );
  });

  it('passes only when the report decision and every score pass', () => {
    const automation = new BrowserPlatformAutomation(null as never, null as never, {} as never);
    const scores = {
      answerability: 90,
      entity: 90,
      evidence: 90,
      platform_fit: 80,
      question: 80,
      readability_safety: 85,
      total: 85,
    } as const;

    expect(
      automation.calculateGate(
        policy(),
        { decision: 'pass', geo_scores: scores, issues: [], score: 90 },
        scores,
      ),
    ).toMatchObject({ blocking_rules: [], passed: true, platform_code: 'lieju' });
  });

  it('uses configured Shanghai slots and avoids occupied timestamps', () => {
    const now = new Date('2026-08-16T01:00:00.000Z');
    const occupied = [new Date('2026-08-16T02:00:00.000Z')];

    expect(nextSchedule(now, ['10:00', '15:30'], occupied).toISOString()).toBe(
      '2026-08-16T07:30:00.000Z',
    );
  });
});

function policy(): BrowserPlatformAutomationPolicy {
  return {
    accountId: crypto.randomUUID(),
    brandConsistencyMin: 90,
    createdBy: crypto.randomUUID(),
    factualAccuracyMin: 90,
    geoTotalMin: 85,
    id: crypto.randomUUID(),
    maxRewrites: 3,
    platformCode: 'lieju',
    platformFitMin: 80,
    publishAttemptLimit: 3,
    questionCoverageMin: 80,
    readabilitySafetyMin: 85,
    scheduleTimes: ['10:00', '15:30'],
  };
}
