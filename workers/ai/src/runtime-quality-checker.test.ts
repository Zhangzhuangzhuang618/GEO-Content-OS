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
    const firstPrompt = adapter.requests[0]!.messages.map((message) => message.content).join('\n');
    expect(firstPrompt).toContain('No identifiable owner company name is declared');
    expect(firstPrompt).not.toContain('广州志远搬家服务有限公司');
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
    expect(repairPrompt).toContain('Valid immutable content locations are limited to');
    expect(repairPrompt).toMatch(/The current title has \d+ Unicode characters/u);
    expect(repairPrompt).toContain('Do not copy them from examples');
    expect(repairPrompt).not.toContain('测试任务提示词');
  });

  it('binds Lieju title, contact, brand, and high-risk semantics before the first check', async () => {
    const clean = QUALITY_CHECKER_CONTRACT_V1.fewShots[0]!;
    const qualityInput = {
      ...clean.input,
      content_version: {
        ...(clean.input['content_version'] as Readonly<Record<string, unknown>>),
        content: {
          blocks: [
            {
              block_key: 'contact',
              text: '如需进一步确认，可通过页面联系方式说明搬运需求。',
            },
          ],
          platform_code: 'lieju',
          title: '广州搬家服务指南',
        },
      },
      platform_rules: {
        ...(clean.input['platform_rules'] as Readonly<Record<string, unknown>>),
        platform_code: 'lieju',
        rules: { contact_in_content_forbidden: true, title_max_characters: 30 },
      },
    };
    const adapter = new QualityMockAdapter([JSON.stringify(clean.output.data)]);
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
          packageId: '10000000-0000-4000-8000-000000000084',
          projectId: '20000000-0000-4000-8000-000000000084',
          promptVersionId: '70000000-0000-4000-8000-000000000072',
          requestId: 'runtime-quality-checker-0084',
          runId: '60000000-0000-4000-8000-000000000072',
          skillName: 'quality-checker',
          skillVersion: '1.0.0',
          tenantId: '90000000-0000-4000-8000-000000000072',
          variantId: '20000000-0000-4000-8000-000000000072',
          workspaceId: '30000000-0000-4000-8000-000000000084',
        },
        qualityInput,
      }),
    ).resolves.toEqual(clean.output.data);

    const firstPrompt = adapter.requests[0]!.messages.map((message) => message.content).join('\n');
    expect(firstPrompt).toContain('within the hard maximum 30');
    expect(firstPrompt).toContain('no exact content location contains a literal phone number');
    expect(firstPrompt).toContain('“通过页面联系方式咨询” is allowed');
    expect(firstPrompt).toContain('Valid immutable content locations are limited to');
    expect(firstPrompt).toContain('Never use brand_policy.*');
    expect(firstPrompt).toContain('“电话公司” are not identifiable company names');
    expect(firstPrompt).toContain('No supplied fact is eligible for a high-risk');
    expect(firstPrompt).not.toContain('"rule_id":"fact.high_risk.unsupported"');
    expect(firstPrompt).not.toContain('"risk_level":"high"');
  });

  it('gives the one semantic repair a structured Lieju contact rejection reason', async () => {
    const clean = QUALITY_CHECKER_CONTRACT_V1.fewShots[0]!;
    const qualityInput = {
      ...clean.input,
      content_version: {
        ...(clean.input['content_version'] as Readonly<Record<string, unknown>>),
        content: {
          blocks: [
            {
              block_key: 'contact',
              text: '如需进一步确认，可通过页面联系方式说明搬运需求。',
            },
          ],
          platform_code: 'lieju',
          title: '广州搬家服务指南',
        },
      },
      platform_rules: {
        ...(clean.input['platform_rules'] as Readonly<Record<string, unknown>>),
        platform_code: 'lieju',
        rules: { contact_in_content_forbidden: true, title_max_characters: 30 },
      },
    };
    const falseContactBlock = {
      ...clean.output.data,
      decision: 'block' as const,
      issues: [
        {
          category: 'compliance' as const,
          citation_ids: [],
          location: 'blocks[0].text',
          message: '正文包含联系方式。',
          rule_id: 'lieju.contact_in_content_forbidden',
          severity: 'BLOCK' as const,
          suggestion: '删除联系方式。',
        },
      ],
      score: 35,
    };
    const adapter = new QualityMockAdapter([
      JSON.stringify(falseContactBlock),
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
          packageId: '10000000-0000-4000-8000-000000000087',
          projectId: '20000000-0000-4000-8000-000000000087',
          promptVersionId: '70000000-0000-4000-8000-000000000075',
          requestId: 'runtime-quality-checker-0087',
          runId: '60000000-0000-4000-8000-000000000075',
          skillName: 'quality-checker',
          skillVersion: '1.0.0',
          tenantId: '90000000-0000-4000-8000-000000000075',
          variantId: '20000000-0000-4000-8000-000000000075',
          workspaceId: '30000000-0000-4000-8000-000000000087',
        },
        qualityInput,
      }),
    ).resolves.toEqual(clean.output.data);

    const repairPrompt = adapter.requests[1]!.messages.map((message) => message.content).join('\n');
    expect(repairPrompt).toContain('prohibited_contact_detail_is_not_present_at_location');
    expect(repairPrompt).toContain('omit the finding unless that location contains a literal');
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
    expect(repairPrompt).toContain('Quality Checker issues are unverifiable');
    expect(repairPrompt).toContain('exact_name_is_not_quoted');
    expect(repairPrompt).toContain('brand.other_company_name issue must quote the exact');
    expect(repairPrompt).toContain('fact.high_risk.unsupported');
    expect(repairPrompt).toContain('There are no eligible high-risk fact locations');
    expect(repairPrompt).toContain('rejections');
    expect(repairPrompt).toContain('location_must_be_eligible_claim');
    expect(repairPrompt).toContain('Correct every rejection object');
    expect(repairPrompt).toContain('blocks[0]');
    expect(repairPrompt).toContain('blocks[0].text');
  });

  it('tells semantic repair that the owner company is allowed without changing the gate', async () => {
    const clean = QUALITY_CHECKER_CONTRACT_V1.fewShots[0]!;
    const qualityInput = {
      ...clean.input,
      brand_policy: {
        ...(clean.input['brand_policy'] as Readonly<Record<string, unknown>>),
        policy: {
          positioning: '广州志远搬家服务有限公司面向广州提供搬迁服务。',
        },
      },
      content_version: {
        ...(clean.input['content_version'] as Readonly<Record<string, unknown>>),
        content: {
          blocks: [
            {
              block_key: 'intro',
              text: '广州志远搬家服务有限公司可根据现场情况说明服务边界。',
            },
          ],
          platform_code: 'lieju',
          title: '厂房搬迁怎么选服务',
        },
      },
    };
    const falseOwnerBlock = {
      ...clean.output.data,
      decision: 'block' as const,
      issues: [
        {
          category: 'brand' as const,
          citation_ids: [],
          location: 'blocks[0].text',
          message: '内容包含禁止的公司名称“广州志远搬家服务有限公司”。',
          rule_id: 'brand.other_company_name',
          severity: 'BLOCK' as const,
          suggestion: '删除公司名称。',
        },
      ],
      score: 35,
    };
    const adapter = new QualityMockAdapter([
      JSON.stringify(falseOwnerBlock),
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
          packageId: '10000000-0000-4000-8000-000000000085',
          projectId: '20000000-0000-4000-8000-000000000085',
          promptVersionId: '70000000-0000-4000-8000-000000000073',
          requestId: 'runtime-quality-checker-0085',
          runId: '60000000-0000-4000-8000-000000000073',
          skillName: 'quality-checker',
          skillVersion: '1.0.0',
          tenantId: '90000000-0000-4000-8000-000000000073',
          variantId: '20000000-0000-4000-8000-000000000073',
          workspaceId: '30000000-0000-4000-8000-000000000085',
        },
        qualityInput,
      }),
    ).resolves.toEqual(clean.output.data);

    expect(adapter.requests).toHaveLength(2);
    const repairPrompt = adapter.requests[1]!.messages.map((message) => message.content).join('\n');
    expect(repairPrompt).toContain('only_allowed_owner_or_generic_name_is_quoted');
    expect(repairPrompt).toContain('广州志远搬家服务有限公司');
    expect(repairPrompt).toContain('do not report them as violations');
  });

  it('recovers when semantic repair repeats the same unverifiable owner-company block', async () => {
    const clean = QUALITY_CHECKER_CONTRACT_V1.fewShots[0]!;
    const owner = '广州志远搬家服务有限公司';
    const qualityInput = {
      ...clean.input,
      brand_policy: {
        ...(clean.input['brand_policy'] as Readonly<Record<string, unknown>>),
        policy: { positioning: `${owner}面向广州提供搬迁服务。` },
      },
      content_version: {
        ...(clean.input['content_version'] as Readonly<Record<string, unknown>>),
        content: {
          blocks: [{ block_key: 'intro', text: `${owner}可根据现场情况说明服务边界。` }],
          platform_code: 'lieju',
          title: '厂房搬迁怎么选服务',
        },
      },
    };
    const falseOwnerBlock = {
      ...clean.output.data,
      decision: 'block' as const,
      issues: [
        {
          category: 'brand' as const,
          citation_ids: [],
          location: 'blocks.intro.text',
          message: `内容包含禁止的公司名称“${owner}”。`,
          rule_id: 'brand.other_company_name',
          severity: 'BLOCK' as const,
          suggestion: '删除公司名称。',
        },
      ],
      score: 35,
    };
    const adapter = new QualityMockAdapter([
      JSON.stringify(falseOwnerBlock),
      JSON.stringify(falseOwnerBlock),
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
          packageId: '10000000-0000-4000-8000-000000000088',
          projectId: '20000000-0000-4000-8000-000000000088',
          promptVersionId: '70000000-0000-4000-8000-000000000075',
          requestId: 'runtime-quality-checker-0088',
          runId: '60000000-0000-4000-8000-000000000075',
          skillName: 'quality-checker',
          skillVersion: '1.0.0',
          tenantId: '90000000-0000-4000-8000-000000000075',
          variantId: '20000000-0000-4000-8000-000000000075',
          workspaceId: '30000000-0000-4000-8000-000000000088',
        },
        qualityInput,
      }),
    ).resolves.toMatchObject({ decision: 'pass', issues: [] });

    expect(adapter.requests).toHaveLength(2);
  });

  it('uses the current tenant owner in both initial policy and semantic repair', async () => {
    const clean = QUALITY_CHECKER_CONTRACT_V1.fewShots[0]!;
    const owner = '广州众人搬家起重吊装有限公司';
    const qualityInput = {
      ...clean.input,
      brand_policy: {
        ...(clean.input['brand_policy'] as Readonly<Record<string, unknown>>),
        policy: {
          cta: `联系${owner}确认需求。`,
          positioning: `${owner}面向广州提供搬迁服务。`,
        },
      },
      content_version: {
        ...(clean.input['content_version'] as Readonly<Record<string, unknown>>),
        content: {
          blocks: [{ block_key: 'intro', text: `${owner}可根据现场情况说明服务边界。` }],
          platform_code: 'lieju',
          title: '厂房搬迁怎么选服务',
        },
      },
    };
    const falseOwnerBlock = {
      ...clean.output.data,
      decision: 'block' as const,
      issues: [
        {
          category: 'brand' as const,
          citation_ids: [],
          location: 'blocks[0].text',
          message: `内容包含禁止的公司名称“${owner}”。`,
          rule_id: 'brand.other_company_name',
          severity: 'BLOCK' as const,
          suggestion: '删除公司名称。',
        },
      ],
      score: 35,
    };
    const adapter = new QualityMockAdapter([
      JSON.stringify(falseOwnerBlock),
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
          packageId: '10000000-0000-4000-8000-000000000086',
          projectId: '20000000-0000-4000-8000-000000000086',
          promptVersionId: '70000000-0000-4000-8000-000000000074',
          requestId: 'runtime-quality-checker-0086',
          runId: '60000000-0000-4000-8000-000000000074',
          skillName: 'quality-checker',
          skillVersion: '1.0.0',
          tenantId: '90000000-0000-4000-8000-000000000074',
          variantId: '20000000-0000-4000-8000-000000000074',
          workspaceId: '30000000-0000-4000-8000-000000000086',
        },
        qualityInput,
      }),
    ).resolves.toEqual(clean.output.data);

    const initialPrompt = adapter.requests[0]!.messages.map((message) => message.content).join(
      '\n',
    );
    const repairPrompt = adapter.requests[1]!.messages.map((message) => message.content).join('\n');
    expect(initialPrompt).toContain(owner);
    expect(initialPrompt).not.toContain('广州志远搬家服务有限公司');
    expect(repairPrompt).toContain(owner);
    expect(repairPrompt).toContain('Correct every rejection object');
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
