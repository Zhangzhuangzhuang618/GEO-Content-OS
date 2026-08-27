import type { QualityCheckerData } from '@geo-content-os/contracts/skills';
import type postgres from 'postgres';
import { describe, expect, it, vi } from 'vitest';

import {
  BrowserPlatformAutomation,
  buildBrowserPlatformRewriteInput,
  type BrowserPlatformAutomationPolicy,
  nextSchedule,
} from './browser-platform-automation.js';
import type { ValidatedGenerationEvent } from './generation.types.js';

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

  it('queues browser-platform work with the canonical Outbox retry column', async () => {
    const statements: string[] = [];
    const automationRunId = '10000000-0000-4000-8000-000000000153';
    const qualityRunId = '20000000-0000-4000-8000-000000000153';
    const transaction = vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      statements.push(sql);
      if (sql.includes('SELECT policy.created_by')) {
        return [
          {
            actorUserId: '30000000-0000-4000-8000-000000000153',
            automationRunId,
            generationRunId: '40000000-0000-4000-8000-000000000153',
            version: 1,
          },
        ];
      }
      if (sql.includes('UPDATE browser_platform_automation_runs')) return [{ id: automationRunId }];
      if (sql.includes('INSERT INTO generation_runs')) return [{ id: qualityRunId }];
      return [];
    }) as unknown as postgres.TransactionSql;
    const automation = new BrowserPlatformAutomation(null as never, null as never, {
      qualityModelKey: 'deepseek-v4-flash',
      qualityPromptVersionId: '50000000-0000-4000-8000-000000000153',
      qualitySkillVersion: '1.0.0',
      rewriteModelKey: 'deepseek-v4',
      writerPromptVersionId: '60000000-0000-4000-8000-000000000153',
      writerSkillVersion: '1.0.0',
    });

    await automation.queueQualityAfterGeneration(
      transaction,
      generationEvent(),
      '70000000-0000-4000-8000-000000000153',
      '80000000-0000-4000-8000-000000000153',
      'a'.repeat(64),
    );

    const outboxInsert = statements.find((sql) => sql.includes('INSERT INTO outbox_events'));
    expect(outboxInsert).toContain('next_attempt_at');
    expect(outboxInsert).not.toContain('available_at');
  });

  it('reuses the original frozen citations for a browser-platform quality rewrite', () => {
    const citation = {
      chunk_id: '10000000-0000-4000-8000-000000000154',
      citation_id: '10000000-0000-4000-8000-000000000154',
      quote_text: '资料类型：企业证照\n证照名称：道路运输经营许可证',
      source_id: '20000000-0000-4000-8000-000000000154',
    };
    const input = {
      brief: {
        constraints: { additional_instructions: '仅使用已提供证据。' },
        platform_codes: ['lieju'],
        title: '厂房搬迁怎么选服务',
      },
      citations: [citation],
      generation_mode: 'draft',
      locked_blocks: [],
      platform_rules_by_code: { lieju: { rules: { title_max_characters: 30 } } },
      strategy: { profile: { positioning: '广州示例搬家有限公司提供搬迁服务。' } },
    };

    const rewrite = buildBrowserPlatformRewriteInput(input, 'lieju');

    expect(rewrite['citations']).toEqual([citation]);
    expect(rewrite['generation_mode']).toBe('rewrite');
    expect(rewrite['brief']).toMatchObject({
      constraints: {
        additional_instructions: expect.stringContaining('仅使用已提供证据。'),
      },
      platform_codes: ['lieju'],
    });
  });

  it('keeps the Douyin image-note contract when rebuilding rewrite input', () => {
    const input = {
      brief: {
        constraints: { additional_instructions: '仅修复本次质量报告。' },
        platform_codes: ['douyin'],
        title: '搬家前怎么准备',
      },
      citations: [],
      generation_mode: 'draft',
      locked_blocks: [],
      platform_rules_by_code: { douyin: { rules: { title_max_characters: 30 } } },
      strategy: { profile: { positioning: '广州示例搬家有限公司提供搬迁服务。' } },
    };

    const rewrite = buildBrowserPlatformRewriteInput(input, 'douyin');
    const brief = rewrite['brief'] as Record<string, unknown>;
    const constraints = brief['constraints'] as Record<string, unknown>;
    const instructions = constraints['additional_instructions'];

    expect(instructions).toEqual(expect.stringContaining('仅修复本次质量报告。'));
    expect(instructions).toEqual(expect.stringContaining('content_kind=image_note'));
    expect(instructions).toEqual(expect.stringContaining('5-10张'));
    expect(instructions).not.toEqual(expect.stringContaining('搜狐号'));
    expect(rewrite['brief']).toMatchObject({ platform_codes: ['douyin'] });
  });
});

function generationEvent(): ValidatedGenerationEvent {
  return {
    data: {
      actorUserId: '30000000-0000-4000-8000-000000000153',
      inputHash: 'b'.repeat(64),
      masterRunId: '90000000-0000-4000-8000-000000000153',
      modelKey: 'deepseek-v4',
      modelPolicy: 'quality',
      packageId: 'a0000000-0000-4000-8000-000000000153',
      projectId: 'b0000000-0000-4000-8000-000000000153',
      promptVersionId: '60000000-0000-4000-8000-000000000153',
      requestId: 'lieju-daily-outbox-test',
      skillVersion: '1.0.0',
      variantRuns: [
        {
          platformCode: 'lieju',
          runId: '40000000-0000-4000-8000-000000000153',
          variantId: '70000000-0000-4000-8000-000000000153',
        },
      ],
      workspaceId: 'c0000000-0000-4000-8000-000000000153',
      writerInput: {},
    },
    eventId: 'd0000000-0000-4000-8000-000000000153',
    occurredAt: '2026-08-17T07:10:00.000Z',
    tenantId: 'e0000000-0000-4000-8000-000000000153',
  };
}

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
