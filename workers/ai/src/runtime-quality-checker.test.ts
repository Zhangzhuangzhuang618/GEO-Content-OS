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
      'Mandatory fact BLOCK locations',
    );
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
