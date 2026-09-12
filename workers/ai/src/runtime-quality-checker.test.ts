import {
  MockModelAdapter,
  type ModelRequest,
  type ModelResult,
} from '@geo-content-os/adapter-model';
import { QUALITY_CHECKER_CONTRACT_V1 } from '@geo-content-os/skills/quality-checker';
import type postgres from 'postgres';
import { describe, expect, it, vi } from 'vitest';

import { RuntimeQualityChecker, regionalTitleIssue } from './runtime-quality-checker.js';

describe('RuntimeQualityChecker', () => {
  it('requires the frozen district in the title without rejecting company names elsewhere', () => {
    const input = {
      editorial_context: {
        schema_version: 'editorial-context@1',
        template_version: 'company-recommendation@1',
        account_id: '11111111-1111-4111-8111-111111111111',
        platform_code: 'official_site',
        policy_version: 1,
        style: 'standard',
        companies: [],
        target_district: '增城',
      },
      content_version: {
        content: { title: '广州搬家多少钱', blocks: [{ text: '广州志远搬家服务有限公司' }] },
      },
    };
    expect(regionalTitleIssue(input, 'official_site')?.rule_id).toBe('readability.regional.title');
    expect(
      regionalTitleIssue(
        {
          ...input,
          content_version: {
            content: { title: '增城搬家多少钱', blocks: input.content_version.content.blocks },
          },
        },
        'official_site',
      ),
    ).toBeNull();
    expect(regionalTitleIssue({ ...input, editorial_context: null }, 'official_site')).toBeNull();
  });
  it('includes subject consistency and unsupported negative inference review for Douyin', async () => {
    const clean = QUALITY_CHECKER_CONTRACT_V1.fewShots[0]!;
    const adapter = new QualityMockAdapter([JSON.stringify(clean.output.data)]);
    const checker = new RuntimeQualityChecker(
      {} as postgres.Sql,
      new Map([[adapter.modelKey, adapter]]),
      vi.fn(),
      async () => ({ systemPrompt: '测试', taskTemplate: '测试' }),
    );
    await checker.evaluate({
      context: {
        inputHash: 'd'.repeat(64),
        modelKey: adapter.modelKey,
        packageId: '10000000-0000-4000-8000-000000000081',
        variantId: null,
        skillName: 'quality-checker',
        projectId: '20000000-0000-4000-8000-000000000081',
        promptVersionId: '70000000-0000-4000-8000-000000000069',
        requestId: 'douyin-logic-review',
        runId: '60000000-0000-4000-8000-000000000069',
        skillVersion: '1.0.0',
        tenantId: '90000000-0000-4000-8000-000000000069',
        workspaceId: '30000000-0000-4000-8000-000000000081',
      },
      qualityInput: {
        ...clean.input,
        platform_rules: {
          ...(clean.input['platform_rules'] as Record<string, unknown>),
          platform_code: 'douyin',
        },
      },
    });
    const prompt = adapter.requests[0]!.messages.map((m) => m.content).join('\n');
    expect(prompt).toContain('前后主语不一致');
    expect(prompt).toContain('不能据此推出');
  });

  it.each([false, true])(
    'runs a separate recommendation reader review and preserves the first report (finding=%s)',
    async (hasFinding) => {
      const clean = QUALITY_CHECKER_CONTRACT_V1.fewShots[0]!;
      const prior = {
        category: 'readability',
        citation_ids: [],
        location: 'blocks[0].text',
        message: '可继续保留的说明。',
        rule_id: 'readability.note',
        severity: 'INFO',
        suggestion: '保持。',
      };
      const adapter = new QualityMockAdapter([
        JSON.stringify({ ...clean.output.data, decision: 'pass', issues: [prior] }),
        JSON.stringify({
          issues: hasFinding
            ? [
                {
                  location: 'blocks[0].text',
                  quote: '服务方案和费用需要确认。',
                  reason: '第二家公司只有预约提醒，没有实质服务细节。',
                  comparison: null,
                  suggestion: 'company_2保留承接身份并展开自己的服务细节。',
                },
              ]
            : [],
        }),
      ]);
      const usage = vi.fn();
      const checker = new RuntimeQualityChecker(
        {} as postgres.Sql,
        new Map([[adapter.modelKey, adapter]]),
        usage,
        async () => ({ systemPrompt: '测试', taskTemplate: '测试' }),
      );
      const result = await checker.evaluate({
        context: {
          inputHash: 'd'.repeat(64),
          modelKey: adapter.modelKey,
          packageId: '10000000-0000-4000-8000-000000000081',
          projectId: '20000000-0000-4000-8000-000000000081',
          promptVersionId: '70000000-0000-4000-8000-000000000069',
          requestId: 'recommendation-reader-review',
          runId: '60000000-0000-4000-8000-000000000069',
          skillName: 'quality-checker',
          skillVersion: '1.0.0',
          tenantId: '90000000-0000-4000-8000-000000000069',
          variantId: '20000000-0000-4000-8000-000000000069',
          workspaceId: '30000000-0000-4000-8000-000000000081',
        },
        qualityInput: {
          ...clean.input,
          recommendation_evidence: [
            {
              citation_id: '41111111-1111-4111-8111-111111111111',
              claim_key: 'company_1',
              quote_text: 'SOURCE_ONLY_SENTINEL',
            },
          ],
          content_version: {
            ...(clean.input['content_version'] as Record<string, unknown>),
            content: {
              title: '广州搬迁怎么选公司',
              blocks: [{ block_key: 'company_2', text: '服务方案和费用需要确认。' }],
              platform_code: 'official_site',
            },
          },
          platform_rules: {
            ...(clean.input['platform_rules'] as Record<string, unknown>),
            platform_code: 'official_site',
          },
          editorial_context: {
            schema_version: 'editorial-context@1',
            template_version: 'company-recommendation@1',
            account_id: '11111111-1111-4111-8111-111111111111',
            policy_version: 1,
            style: 'company_recommendation',
            platform_code: 'official_site',
            companies: ['甲测试有限公司', '乙测试有限公司'].map((legal_name, index) => ({
              id: `21111111-1111-4111-8111-11111111111${index}`,
              legal_name,
              source_document_ids: [`31111111-1111-4111-8111-11111111111${index}`],
            })),
          },
        },
      });
      expect(result.decision).toBe(hasFinding ? 'revise' : 'pass');
      expect(result.issues[0]).toEqual(prior);
      expect(result.issues).toHaveLength(hasFinding ? 2 : 1);
      expect(result.geo_scores).toEqual(clean.output.data.geo_scores);
      expect(adapter.requests).toHaveLength(2);
      expect(usage).toHaveBeenCalledTimes(2);
      expect(adapter.requests[1]?.messages.map((m) => m.content).join()).not.toContain(
        'geo_result',
      );
      expect(adapter.requests[1]?.messages.map((m) => m.content).join()).not.toContain(
        'SOURCE_ONLY_SENTINEL',
      );
    },
  );
  it.each(['official_site', 'lieju', 'douyin'] as const)(
    'sends %s recommendation evidence and keeps a source-based overreach blocker',
    async (platform) => {
      const clean = QUALITY_CHECKER_CONTRACT_V1.fewShots[0]!;
      const evidence = [
        {
          citation_id: '41111111-1111-4111-8111-111111111111',
          claim_key: 'company_1',
          quote_text:
            '半日式包含整理、收纳、搬迁、放到指定房间。全日式额外包含衣物入柜和厨房拆包摆放。家具、电器拆装另收费。',
        },
      ];
      const blocked = {
        ...clean.output.data,
        decision: 'block',
        score: 40,
        issues: [
          {
            category: 'fact',
            citation_ids: [],
            location: 'blocks[0].text',
            message: '“全日式包括免费家具拆装”与该企业资料“家具、电器拆装另收费”矛盾。',
            rule_id: 'fact.recommendation.claim_overreach',
            severity: 'BLOCK',
            suggestion: '明确拆装额外收费。',
          },
        ],
      };
      const adapter = new QualityMockAdapter([JSON.stringify(blocked)]);
      const checker = new RuntimeQualityChecker(
        {} as postgres.Sql,
        new Map([[adapter.modelKey, adapter]]),
        vi.fn(),
        async () => ({ systemPrompt: '测试', taskTemplate: '测试' }),
      );
      const result = await checker.evaluate({
        context: {
          inputHash: 'd'.repeat(64),
          modelKey: adapter.modelKey,
          packageId: '10000000-0000-4000-8000-000000000081',
          projectId: '20000000-0000-4000-8000-000000000081',
          promptVersionId: '70000000-0000-4000-8000-000000000069',
          requestId: 'recommendation-source-check',
          runId: '60000000-0000-4000-8000-000000000069',
          skillName: 'quality-checker',
          skillVersion: '1.0.0',
          tenantId: '90000000-0000-4000-8000-000000000069',
          variantId: '20000000-0000-4000-8000-000000000069',
          workspaceId: '30000000-0000-4000-8000-000000000081',
        },
        qualityInput: {
          ...clean.input,
          content_version: {
            ...(clean.input['content_version'] as Record<string, unknown>),
            content: {
              ...((clean.input['content_version'] as Record<string, unknown>)['content'] as Record<
                string,
                unknown
              >),
              platform_meta: {
                cards: [
                  {
                    card_key: 'company_1',
                    heading: '半日式整理收纳',
                    body: '半日式包含整理、收纳、搬迁、放到指定房间。',
                  },
                ],
              },
            },
          },
          recommendation_evidence: evidence,
          platform_rules: {
            ...(clean.input['platform_rules'] as Record<string, unknown>),
            platform_code: platform,
          },
          editorial_context: {
            schema_version: 'editorial-context@1',
            template_version: 'company-recommendation@1',
            account_id: '11111111-1111-4111-8111-111111111111',
            policy_version: 1,
            style: 'company_recommendation',
            platform_code: platform,
            companies: ['甲测试有限公司', '乙测试有限公司'].map((legal_name, index) => ({
              id: `21111111-1111-4111-8111-11111111111${index}`,
              legal_name,
              source_document_ids: [`31111111-1111-4111-8111-11111111111${index}`],
            })),
          },
        },
      });
      expect(result).toEqual(blocked);
      const messages = adapter.requests[0]!.messages.map((message) => message.content).join('\n');
      expect(messages).toContain(evidence[0]!.quote_text);
      if (platform === 'official_site') {
        expect(messages).toContain('正文约1100字');
        expect(messages).toContain('不以凑字数为修改理由');
      } else {
        expect(messages).not.toContain('正文约1100字');
        expect(messages).toContain(
          'All existing body-length constraints for this platform still apply.',
        );
      }
      expect(messages).toContain('a supported verdict alone is NOT proof');
      expect(messages).toContain('fact.recommendation.claim_overreach');
      expect(messages).toContain('详细流程的重复必须引用两处原文');
      expect(messages).toContain('不能为避重把第二家完整搬迁服务缩成单一拆装工种');
      expect(messages).toContain('负责人明确确认并作为绑定资料提供的服务事实可以直接采用');
      expect(messages).toContain('卡片“拆装另收费”配正文的额外收费说明是标题匹配');
      expect(messages).toContain('不能拿第一家绑定资料中的内容当成第一家已写出的正文');
      expect(messages).toContain('必须检查实际换行');
      expect(messages).toContain('以下是实际同卡标题与正文配对');
      expect(messages).toContain('半日式整理收纳');
      expect(messages).toContain('不能要求标题概括未摘入此卡的公司全文');
      expect(messages).toContain('禁止把这些展示面之间的相同内容判为文章重复');
      expect(messages).toContain('官网渲染器会把platform_meta.faq直接渲染');
      expect(messages).toContain('不等于声称该企业只做这一部分');
      expect(messages).toContain('不能用另一家搬迁公司的家具电器拆装资料支持');
      expect(
        adapter.requests[0]!.messages.some((message) => message.content?.includes('example_input')),
      ).toBe(false);
    },
  );
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

  it('does not add a final repair for repeated non-brand semantic failures', async () => {
    const clean = QUALITY_CHECKER_CONTRACT_V1.fewShots[0]!;
    const wrongScores = {
      ...clean.output.data,
      geo_scores: { ...clean.output.data.geo_scores, total: 1 },
    };
    const adapter = new QualityMockAdapter([
      JSON.stringify(wrongScores),
      JSON.stringify(wrongScores),
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
          packageId: '10000000-0000-4000-8000-000000000091',
          projectId: '20000000-0000-4000-8000-000000000091',
          promptVersionId: '70000000-0000-4000-8000-000000000078',
          requestId: 'runtime-quality-checker-0091',
          runId: '60000000-0000-4000-8000-000000000078',
          skillName: 'quality-checker',
          skillVersion: '1.0.0',
          tenantId: '90000000-0000-4000-8000-000000000078',
          variantId: '20000000-0000-4000-8000-000000000078',
          workspaceId: '30000000-0000-4000-8000-000000000091',
        },
        qualityInput: clean.input,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_OUTPUT_INVALID' });

    expect(adapter.requests).toHaveLength(2);
  });

  it('binds Lieju title, URL allowance, brand, and high-risk semantics before the first check', async () => {
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
            {
              block_key: 'verify',
              text: '道路运输许可可在交通运输部官方平台（ysfw.mot.gov.cn）核验。',
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
    expect(firstPrompt).toContain('URLs and a neutral phrase');
    expect(firstPrompt).toContain('are allowed');
    expect(firstPrompt).toContain(
      'no exact content location contains a literal phone number, WeChat ID, or QQ ID',
    );
    expect(firstPrompt).toContain('Valid immutable content locations are limited to');
    expect(firstPrompt).toContain('Never use brand_policy.*');
    expect(firstPrompt).toContain('“电话公司” are not identifiable company names');
    expect(firstPrompt).toContain('No supplied fact is eligible for a high-risk');
    expect(firstPrompt).not.toContain('"rule_id":"fact.high_risk.unsupported"');
    expect(firstPrompt).not.toContain('"risk_level":"high"');
  });

  it('recovers when semantic repair repeats the same false Lieju contact block', async () => {
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
      JSON.stringify(falseContactBlock),
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
    ).resolves.toMatchObject({ decision: 'pass', issues: [], score: 35 });

    expect(adapter.requests).toHaveLength(2);
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

  it('recovers repeated non-identifiable brand and ineligible high-risk findings together', async () => {
    const clean = QUALITY_CHECKER_CONTRACT_V1.fewShots[0]!;
    const qualityInput = {
      ...clean.input,
      content_version: {
        ...(clean.input['content_version'] as Readonly<Record<string, unknown>>),
        content: {
          blocks: [{ block_key: 'company-body', text: '搬迁前应先核对设备清单。' }],
          platform_code: 'lieju',
          title: '厂房搬迁怎么选服务',
        },
      },
    };
    const falseBlocks = {
      ...clean.output.data,
      decision: 'block' as const,
      issues: [
        {
          category: 'brand' as const,
          citation_ids: [],
          location: 'blocks[0].text',
          message: '内容包含禁止的公司名称“设备清单”。',
          rule_id: 'brand.other_company_name',
          severity: 'BLOCK' as const,
          suggestion: '改为匿名表述。',
        },
        {
          category: 'fact' as const,
          citation_ids: [],
          location: 'blocks.company-body.text',
          message: '高风险事实缺少支持证据。',
          rule_id: 'fact.high_risk.unsupported',
          severity: 'BLOCK' as const,
          suggestion: '补充权威证据或删除该事实。',
        },
      ],
      score: 35,
    };
    const adapter = new QualityMockAdapter([
      JSON.stringify(falseBlocks),
      JSON.stringify(falseBlocks),
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
          packageId: '10000000-0000-4000-8000-000000000091',
          projectId: '20000000-0000-4000-8000-000000000091',
          promptVersionId: '70000000-0000-4000-8000-000000000078',
          requestId: 'runtime-quality-checker-0091',
          runId: '60000000-0000-4000-8000-000000000078',
          skillName: 'quality-checker',
          skillVersion: '1.0.0',
          tenantId: '90000000-0000-4000-8000-000000000078',
          variantId: '20000000-0000-4000-8000-000000000078',
          workspaceId: '30000000-0000-4000-8000-000000000091',
        },
        qualityInput,
      }),
    ).resolves.toMatchObject({ decision: 'pass', issues: [] });

    expect(adapter.requests).toHaveLength(2);
  });

  it('uses one final repair when the first semantic repair returns only malformed brand findings', async () => {
    const clean = QUALITY_CHECKER_CONTRACT_V1.fewShots[0]!;
    const malformedBrandBlock = {
      ...clean.output.data,
      decision: 'block' as const,
      issues: [
        {
          category: 'brand' as const,
          citation_ids: [],
          location: 'blocks[0].text',
          message: '内容中出现了其他企业名称。',
          rule_id: 'brand.other_company_name',
          severity: 'BLOCK' as const,
          suggestion: '删除其他企业名称。',
        },
      ],
      score: 35,
    };
    const adapter = new QualityMockAdapter([
      JSON.stringify(malformedBrandBlock),
      JSON.stringify(malformedBrandBlock),
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
          packageId: '10000000-0000-4000-8000-000000000089',
          projectId: '20000000-0000-4000-8000-000000000089',
          promptVersionId: '70000000-0000-4000-8000-000000000076',
          requestId: 'runtime-quality-checker-0089',
          runId: '60000000-0000-4000-8000-000000000076',
          skillName: 'quality-checker',
          skillVersion: '1.0.0',
          tenantId: '90000000-0000-4000-8000-000000000076',
          variantId: '20000000-0000-4000-8000-000000000076',
          workspaceId: '30000000-0000-4000-8000-000000000089',
        },
        qualityInput: clean.input,
      }),
    ).resolves.toEqual(clean.output.data);

    expect(adapter.requests).toHaveLength(3);
    const finalRepairPrompt = adapter.requests[2]!.messages.map((message) => message.content).join(
      '\n',
    );
    expect(finalRepairPrompt).toContain('exact_name_is_not_quoted');
    expect(finalRepairPrompt).toContain('omit the finding unless its message quotes one exact');
  });

  it('stops after the bounded final brand repair remains invalid', async () => {
    const clean = QUALITY_CHECKER_CONTRACT_V1.fewShots[0]!;
    const malformedBrandBlock = {
      ...clean.output.data,
      decision: 'block' as const,
      issues: [
        {
          category: 'brand' as const,
          citation_ids: [],
          location: 'blocks[0].text',
          message: '内容中出现了其他企业名称。',
          rule_id: 'brand.other_company_name',
          severity: 'BLOCK' as const,
          suggestion: '删除其他企业名称。',
        },
      ],
      score: 35,
    };
    const adapter = new QualityMockAdapter([
      JSON.stringify(malformedBrandBlock),
      JSON.stringify(malformedBrandBlock),
      JSON.stringify(malformedBrandBlock),
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
          packageId: '10000000-0000-4000-8000-000000000090',
          projectId: '20000000-0000-4000-8000-000000000090',
          promptVersionId: '70000000-0000-4000-8000-000000000077',
          requestId: 'runtime-quality-checker-0090',
          runId: '60000000-0000-4000-8000-000000000077',
          skillName: 'quality-checker',
          skillVersion: '1.0.0',
          tenantId: '90000000-0000-4000-8000-000000000077',
          variantId: '20000000-0000-4000-8000-000000000077',
          workspaceId: '30000000-0000-4000-8000-000000000090',
        },
        qualityInput: clean.input,
      }),
    ).rejects.toMatchObject({
      code: 'SKILL_OUTPUT_INVALID',
    });

    expect(adapter.requests).toHaveLength(3);
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
