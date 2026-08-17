import {
  MockModelAdapter,
  type ModelRequest,
  type ModelResult,
} from '@geo-content-os/adapter-model';
import { QUALITY_CHECKER_CONTRACT_V1 } from '@geo-content-os/skills/quality-checker';
import type postgres from 'postgres';
import { describe, expect, it, vi } from 'vitest';

import { RuntimeQualityChecker } from './runtime-quality-checker.js';

describe('RuntimeQualityChecker', () => {
  it('retries a schema-valid result that omitted mandatory high-risk blockers', async () => {
    const clean = QUALITY_CHECKER_CONTRACT_V1.fewShots[0]!;
    const highRisk = QUALITY_CHECKER_CONTRACT_V1.fewShots[1]!;
    const adapter = new QualityMockAdapter([
      JSON.stringify(clean.output.data),
      JSON.stringify(highRisk.output.data),
    ]);
    const recordUsage = vi.fn();
    const checker = new RuntimeQualityChecker(
      {} as postgres.Sql,
      new Map([[adapter.modelKey, adapter]]),
      recordUsage,
      async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
    );

    const result = await checker.evaluate({
      context: {
        inputHash: 'd'.repeat(64),
        modelKey: adapter.modelKey,
        packageId: '10000000-0000-4000-8000-000000000081',
        projectId: '20000000-0000-4000-8000-000000000081',
        promptVersionId: '70000000-0000-4000-8000-000000000069',
        requestId: 'runtime-quality-checker-0081',
        runId: '60000000-0000-4000-8000-000000000069',
        skillName: 'quality-checker',
        skillVersion: '1.0.0',
        tenantId: '90000000-0000-4000-8000-000000000069',
        variantId: '20000000-0000-4000-8000-000000000069',
        workspaceId: '30000000-0000-4000-8000-000000000081',
      },
      qualityInput: highRisk.input,
    });

    expect(result).toMatchObject({
      decision: 'block',
      issues: expect.arrayContaining([
        expect.objectContaining({
          category: 'fact',
          location: 'claim:workflow-value',
          severity: 'BLOCK',
        }),
      ]),
    });
    expect(recordUsage).toHaveBeenCalledTimes(2);
    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[1]!.messages.map((message) => message.content).join('\n')).toContain(
      'Mandatory server-required issues',
    );
    expect(adapter.requests[1]!.messages.map((message) => message.content).join('\n')).toContain(
      '"location":"claim:workflow-value"',
    );
    expect(adapter.requests[1]!.messages.map((message) => message.content).join('\n')).toContain(
      '"severity":"BLOCK"',
    );
    expect(adapter.requests[1]!.messages.map((message) => message.content).join('\n')).toContain(
      'High-risk fact issues are allowed only at these exact locations: ["claim:workflow-value"]',
    );
    expect(adapter.requests[0]!.messages.map((message) => message.content).join('\n')).toContain(
      '广州志远搬家服务有限公司',
    );
    expect(adapter.requests.every((request) => request.tools === undefined)).toBe(true);
  });

  it('does not force a block when semantic repair only needs the frozen GEO scores', async () => {
    const clean = QUALITY_CHECKER_CONTRACT_V1.fewShots[0]!;
    const wrongScores = {
      ...clean.output.data,
      geo_scores: { ...clean.output.data.geo_scores, total: 1 },
    };
    const adapter = new QualityMockAdapter([
      JSON.stringify(wrongScores),
      JSON.stringify(clean.output.data),
    ]);
    const checker = new RuntimeQualityChecker(
      {} as postgres.Sql,
      new Map([[adapter.modelKey, adapter]]),
      vi.fn(),
      async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
    );

    await expect(
      checker.evaluate({
        context: {
          inputHash: 'd'.repeat(64),
          modelKey: adapter.modelKey,
          packageId: '10000000-0000-4000-8000-000000000082',
          projectId: '20000000-0000-4000-8000-000000000082',
          promptVersionId: '70000000-0000-4000-8000-000000000070',
          requestId: 'runtime-quality-checker-0082',
          runId: '60000000-0000-4000-8000-000000000070',
          skillName: 'quality-checker',
          skillVersion: '1.0.0',
          tenantId: '90000000-0000-4000-8000-000000000070',
          variantId: '20000000-0000-4000-8000-000000000070',
          workspaceId: '30000000-0000-4000-8000-000000000082',
        },
        qualityInput: clean.input,
      }),
    ).resolves.toEqual(clean.output.data);

    const repairPrompt = adapter.requests[1]!.messages.map((message) => message.content).join('\n');
    expect(repairPrompt).toContain('No server-required BLOCK issue was identified');
    expect(repairPrompt).toContain('Mandatory server-required issues: []');
    expect(repairPrompt).toContain('There are no eligible high-risk fact locations');
    expect(repairPrompt).toContain('Do not copy them from examples');
  });

  it('retries ghost brand and fact blockers without persisting them as quality findings', async () => {
    const clean = QUALITY_CHECKER_CONTRACT_V1.fewShots[0]!;
    const qualityInput = {
      ...clean.input,
      content_version: {
        ...(clean.input['content_version'] as Readonly<Record<string, unknown>>),
        content: {
          blocks: [
            {
              block_key: 'intro',
              text: '工厂搬迁前应先确认设备清单、责任边界和验收标准。',
            },
          ],
          platform_code: 'baijiahao',
          title: '广州工厂搬迁准备指南',
        },
      },
    };
    const ghostOutput = {
      ...clean.output.data,
      decision: 'block' as const,
      issues: [
        {
          category: 'brand' as const,
          citation_ids: [],
          location: 'blocks[0].text',
          message: '内容中出现了其他可识别公司名称，违反品牌名称硬性规定。',
          rule_id: 'brand.other_company_name',
          severity: 'BLOCK' as const,
          suggestion: '将其他公司名称替换为“某公司”等匿名表述。',
        },
        {
          category: 'fact' as const,
          citation_ids: [],
          location: 'blocks[0].text',
          message: '高风险事实缺少支持证据。',
          rule_id: 'fact.high_risk.unsupported',
          severity: 'BLOCK' as const,
          suggestion: '补充权威证据或删除该事实。',
        },
      ],
      score: 35,
    };
    const adapter = new QualityMockAdapter([
      JSON.stringify(ghostOutput),
      JSON.stringify(clean.output.data),
    ]);
    const checker = new RuntimeQualityChecker(
      {} as postgres.Sql,
      new Map([[adapter.modelKey, adapter]]),
      vi.fn(),
      async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
    );

    await expect(
      checker.evaluate({
        context: {
          inputHash: 'd'.repeat(64),
          modelKey: adapter.modelKey,
          packageId: '10000000-0000-4000-8000-000000000083',
          projectId: '20000000-0000-4000-8000-000000000083',
          promptVersionId: '70000000-0000-4000-8000-000000000071',
          requestId: 'runtime-quality-checker-0083',
          runId: '60000000-0000-4000-8000-000000000071',
          skillName: 'quality-checker',
          skillVersion: '1.0.0',
          tenantId: '90000000-0000-4000-8000-000000000071',
          variantId: '20000000-0000-4000-8000-000000000071',
          workspaceId: '30000000-0000-4000-8000-000000000083',
        },
        qualityInput,
      }),
    ).resolves.toEqual(clean.output.data);

    expect(adapter.requests).toHaveLength(2);
    const repairPrompt = adapter.requests[1]!.messages.map((message) => message.content).join('\n');
    expect(repairPrompt).toContain('No server-required BLOCK issue was identified');
    expect(repairPrompt).toContain(
      'Quality Checker brand issue does not identify a prohibited name at its location',
    );
    expect(repairPrompt).toContain('brand.other_company_name issue must quote the exact');
    expect(repairPrompt).toContain('fact.high_risk.unsupported');
    expect(repairPrompt).toContain('There are no eligible high-risk fact locations');
  });
});

class QualityMockAdapter extends MockModelAdapter {
  public readonly requests: ModelRequest[] = [];
  private responseIndex = 0;

  public constructor(private readonly outputs: readonly string[]) {
    super({ modelKey: 'deepseek-v4-pro' });
  }

  public override async generate(input: ModelRequest): Promise<ModelResult> {
    this.requests.push(input);
    const base = await super.generate({ ...input, responseFormat: { type: 'text' } });
    const content = this.outputs[this.responseIndex] ?? '';
    this.responseIndex += 1;
    return Object.freeze({
      ...base,
      message: Object.freeze({ content, role: 'assistant' as const }),
    });
  }
}
