import { CONTENT_WRITER_CONTRACT_V1 } from '@geo-content-os/skills/content-writer';
import type postgres from 'postgres';
import { describe, expect, it, vi } from 'vitest';

import { readAiWorkerConfig } from './config.js';
import type { ContentWriterRunContext, JsonObject } from './generation.types.js';
import { RuntimeContentWriter } from './runtime-content-writer.js';
import { createRuntimeModels } from './runtime-model.js';

const MASTER_RUN = '70000000-0000-4000-8000-000000000061';
const VARIANT_RUN = '71000000-0000-4000-8000-000000000061';

describe('AI Worker runtime wiring', () => {
  it('runs Content Writer once and reuses its platform variants', async () => {
    const recordUsage = vi.fn();
    const writer = new RuntimeContentWriter(
      {} as postgres.Sql,
      createRuntimeModels('mock', {
        CONTENT_MODEL_BALANCED_KEY: 'deepseek-v4-flash',
      } as NodeJS.ProcessEnv),
      recordUsage,
      async () => ({ systemPrompt: '测试系统提示词', taskTemplate: '测试任务提示词' }),
    );
    const fixture = CONTENT_WRITER_CONTRACT_V1.fewShots[0]!;
    const masterContext = context(MASTER_RUN, null);
    const master = await writer.generateMaster({
      context: masterContext,
      requestId: 'runtime-content-master-0061',
      writerInput: fixture.input as JsonObject,
    });
    const variant = await writer.generateVariant({
      context: context(VARIANT_RUN, '72000000-0000-4000-8000-000000000061'),
      masterContent: master,
      platformCode: 'xiaohongshu',
      requestId: 'runtime-content-xiaohongshu-0061',
      writerInput: fixture.input as JsonObject,
    });

    expect(master.platform_code).toBe('master');
    expect(variant.platform_code).toBe('xiaohongshu');
    expect(recordUsage).toHaveBeenCalledOnce();
  });

  it('forbids the Mock model in production', () => {
    expect(() =>
      readAiWorkerConfig({
        AI_MODEL_DRIVER: 'mock',
        DATABASE_URL: 'postgresql://local/test',
        NODE_ENV: 'production',
        REDIS_URL: 'redis://local',
      } as NodeJS.ProcessEnv),
    ).toThrow('forbidden in production');
  });
});

function context(runId: string, variantId: string | null): ContentWriterRunContext {
  return Object.freeze({
    batchKey: 'a0000000-0000-4000-8000-000000000061',
    skillName: 'content-writer',
    inputHash: 'a'.repeat(64),
    modelKey: 'deepseek-v4-flash',
    modelPolicy: 'fast',
    packageId: '60000000-0000-4000-8000-000000000061',
    projectId: '40000000-0000-4000-8000-000000000061',
    promptVersionId: '80000000-0000-4000-8000-000000000061',
    runId,
    skillVersion: '1.0.0',
    tenantId: '90000000-0000-4000-8000-000000000061',
    variantId,
    workspaceId: '91000000-0000-4000-8000-000000000061',
  });
}
