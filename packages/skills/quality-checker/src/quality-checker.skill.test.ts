import { MockModelAdapter, type JsonObject } from '@geo-content-os/adapter-model';
import { DeepSeekModelAdapter } from '@geo-content-os/adapter-model-deepseek';
import {
  CREATE_QUALITY_ISSUE_TOOL,
  GET_PLATFORM_RULES_TOOL,
  REQUEST_HUMAN_REVIEW_TOOL,
  SEARCH_KNOWLEDGE_TOOL,
} from '@geo-content-os/contracts/skills';
import {
  createSkillContext,
  SchemaGuard,
  SkillRunner,
  type SkillTool,
  ToolRegistry,
} from '@geo-content-os/skills/runtime';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { QUALITY_CHECKER_CONTRACT_V1 } from '../contracts/v1.0.0/index.js';
import { QualityCheckerSkill } from './quality-checker.skill.js';

const closers: Array<() => Promise<void>> = [];
const fixture = QUALITY_CHECKER_CONTRACT_V1.fewShots[0]!;
const context = createSkillContext({
  inputHash: 'd'.repeat(64),
  modelKey: 'flash',
  projectId: '80000000-0000-4000-8000-000000000069',
  promptVersionId: '70000000-0000-4000-8000-000000000069',
  requestId: 'request-quality-checker-0069',
  runId: '60000000-0000-4000-8000-000000000069',
  skillName: 'quality-checker',
  skillVersion: '1.0.0',
  tenantId: '90000000-0000-4000-8000-000000000069',
  workspaceId: 'a0000000-0000-4000-8000-000000000069',
});

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe('QualityCheckerSkill', () => {
  it('uses the frozen tool whitelist with the Mock Adapter', async () => {
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [rulesCall(), { text: JSON.stringify(fixture.output.data) }],
    });
    const result = await skill(adapter).run({
      context,
      input: fixture.input,
      recordUsage: () => undefined,
    });
    expect(result).toMatchObject({ output: { data: fixture.output.data }, toolCallCount: 1 });
    expect(result.toolResults.map((item) => item.name)).toEqual(['get_platform_rules']);
  });

  it('rejects failure to block a high-risk unsupported fact', async () => {
    const negative = QUALITY_CHECKER_CONTRACT_V1.fewShots[1]!;
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [{ text: JSON.stringify(fixture.output.data) }],
    });
    await expect(
      skill(adapter).run({ context, input: negative.input, recordUsage: () => undefined }),
    ).rejects.toMatchObject({ code: 'SKILL_OUTPUT_INVALID' });
  });

  it('enforces the warning threshold boundary', async () => {
    const boundary = QUALITY_CHECKER_CONTRACT_V1.fewShots[2]!;
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [{ text: JSON.stringify(boundary.output.data) }],
    });
    await expect(
      skill(adapter).run({ context, input: boundary.input, recordUsage: () => undefined }),
    ).resolves.toMatchObject({ output: { data: { decision: 'revise' } } });
  });

  it('rejects a company-name block without an exact prohibited name at its location', async () => {
    const input = qualityInputWithBlocks([
      {
        block_key: 'intro',
        text: '工厂搬迁前应先确认设备清单、责任边界和验收标准。',
      },
    ]);
    const output = blockedOutput({
      category: 'brand',
      citation_ids: [],
      location: 'blocks[0].text',
      message: '内容中出现了其他可识别公司名称，违反品牌名称硬性规定。',
      rule_id: 'brand.other_company_name',
      severity: 'BLOCK',
      suggestion: '将其他公司名称替换为“某公司”等匿名表述。',
    });
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [{ text: JSON.stringify(output) }],
    });

    await expect(
      skill(adapter).run({ context, input, recordUsage: () => undefined }),
    ).rejects.toMatchObject({
      code: 'SKILL_OUTPUT_INVALID',
      message: expect.stringContaining('"reason":"exact_name_is_not_quoted"'),
    });
  });

  it('identifies the wrong category on a company-name block', async () => {
    const input = qualityInputWithBlocks([{ block_key: 'intro', text: '可通过货拉拉安排运输。' }]);
    const output = blockedOutput({
      category: 'compliance',
      citation_ids: [],
      location: 'blocks[0].text',
      message: '内容包含禁止的第三方品牌“货拉拉”。',
      rule_id: 'brand.other_company_name',
      severity: 'BLOCK',
      suggestion: '改为匿名表述。',
    });
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [{ text: JSON.stringify(output) }],
    });

    await expect(
      skill(adapter).run({ context, input, recordUsage: () => undefined }),
    ).rejects.toMatchObject({
      code: 'SKILL_OUTPUT_INVALID',
      message: expect.stringContaining('"reason":"category_must_be_brand"'),
    });
  });

  it('rejects a high-risk fact block that does not match fact_results', async () => {
    const input = qualityInputWithBlocks([
      {
        block_key: 'intro',
        text: '工厂搬迁前应先确认设备清单、责任边界和验收标准。',
      },
    ]);
    const output = blockedOutput({
      category: 'fact',
      citation_ids: [],
      location: 'blocks[0].text',
      message: '高风险事实缺少支持证据。',
      rule_id: 'fact.high_risk.unsupported',
      severity: 'BLOCK',
      suggestion: '补充权威证据或删除该事实。',
    });
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [{ text: JSON.stringify(output) }],
    });

    await expect(
      skill(adapter).run({ context, input, recordUsage: () => undefined }),
    ).rejects.toMatchObject({ code: 'SKILL_OUTPUT_INVALID' });
  });

  it('enforces the Lieju title_max_characters hard limit', async () => {
    const input = qualityInputWithTitleRule(
      '广州搬家服务流程与收费说明以及预约注意事项完整指南',
      20,
    );
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [{ text: JSON.stringify(fixture.output.data) }],
    });

    await expect(
      skill(adapter).run({ context, input, recordUsage: () => undefined }),
    ).rejects.toMatchObject({ code: 'SKILL_OUTPUT_INVALID' });
  });

  it.each(['lieju.title.max_characters', 'platform.title_max_characters'])(
    'rejects a false %s block when the title is within the configured limit',
    async (ruleId) => {
      const input = qualityInputWithTitleRule('广州搬家服务指南', 30);
      const output = blockedOutput({
        category: 'format',
        citation_ids: [],
        location: 'title',
        message: '标题超过列举网长度限制。',
        rule_id: ruleId,
        severity: 'BLOCK',
        suggestion: '缩短标题。',
      });
      const adapter = new MockModelAdapter({
        modelKey: 'flash',
        responses: [{ text: JSON.stringify(output) }],
      });

      await expect(
        skill(adapter).run({ context, input, recordUsage: () => undefined }),
      ).rejects.toMatchObject({ code: 'SKILL_OUTPUT_INVALID' });
    },
  );

  it('accepts a matching title limit block for an over-limit title', async () => {
    const input = qualityInputWithTitleRule(
      '广州搬家服务流程与收费说明以及预约注意事项完整指南',
      20,
    );
    const output = blockedOutput({
      category: 'format',
      citation_ids: [],
      location: 'title',
      message: '标题超过列举网长度限制。',
      rule_id: 'lieju.title.max_characters',
      severity: 'BLOCK',
      suggestion: '缩短标题。',
    });
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [{ text: JSON.stringify(output) }],
    });

    await expect(
      skill(adapter).run({ context, input, recordUsage: () => undefined }),
    ).resolves.toMatchObject({ output: { data: { decision: 'block' } } });
  });

  it('rejects a Lieju contact block for a neutral page-contact phrase', async () => {
    const input = qualityInputWithTitleRule('广州搬家服务指南', 30, [
      {
        block_key: 'contact',
        text: '如需进一步确认，可通过页面联系方式说明搬运需求。',
      },
    ]);
    const output = blockedOutput({
      category: 'compliance',
      citation_ids: [],
      location: 'blocks[0].text',
      message: '正文包含联系方式引导。',
      rule_id: 'lieju.contact_in_content_forbidden',
      severity: 'BLOCK',
      suggestion: '删除该句。',
    });
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [{ text: JSON.stringify(output) }],
    });

    await expect(
      skill(adapter).run({ context, input, recordUsage: () => undefined }),
    ).rejects.toMatchObject({ code: 'SKILL_OUTPUT_INVALID' });
  });

  it('recovers an exact false Lieju contact block after semantic repair', async () => {
    const input = qualityInputWithTitleRule('广州搬家服务指南', 30, [
      { block_key: 'contact', text: '如需进一步确认，可通过页面联系方式说明搬运需求。' },
    ]);
    const output = blockedOutput({
      category: 'compliance',
      citation_ids: [],
      location: 'blocks[0].text',
      message: '正文包含联系方式引导。',
      rule_id: 'lieju.contact_in_content_forbidden',
      severity: 'BLOCK',
      suggestion: '删除该句。',
    });

    await expect(
      skill(
        new MockModelAdapter({ modelKey: 'flash', responses: [{ text: JSON.stringify(output) }] }),
      ).run({
        context,
        input,
        recordUsage: () => undefined,
        recoverDeterministicFalsePositiveIssues: true,
      }),
    ).resolves.toMatchObject({ output: { data: { decision: 'pass', issues: [] } } });
  });

  it('accepts a Lieju contact block that points to a literal phone number', async () => {
    const input = qualityInputWithTitleRule('广州搬家服务指南', 30, [
      { block_key: 'contact', text: '可拨打02085627757咨询。' },
    ]);
    const output = blockedOutput({
      category: 'compliance',
      citation_ids: [],
      location: 'blocks[0].text',
      message: '正文包含电话号码“02085627757”。',
      rule_id: 'lieju.contact_in_content_forbidden',
      severity: 'BLOCK',
      suggestion: '删除电话号码。',
    });
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [{ text: JSON.stringify(output) }],
    });

    await expect(
      skill(adapter).run({
        context,
        input,
        recordUsage: () => undefined,
        recoverDeterministicFalsePositiveIssues: true,
      }),
    ).resolves.toMatchObject({ output: { data: { decision: 'block' } } });
  });

  it('does not recover a malformed Lieju contact finding', async () => {
    const input = qualityInputWithTitleRule('广州搬家服务指南', 30, [
      { block_key: 'contact', text: '通过页面联系方式说明需求。' },
    ]);
    const output = blockedOutput({
      category: 'brand',
      citation_ids: [],
      location: 'blocks[0].text',
      message: '正文包含联系方式。',
      rule_id: 'lieju.contact_in_content_forbidden',
      severity: 'BLOCK',
      suggestion: '删除联系方式。',
    });

    await expect(
      skill(
        new MockModelAdapter({ modelKey: 'flash', responses: [{ text: JSON.stringify(output) }] }),
      ).run({
        context,
        input,
        recordUsage: () => undefined,
        recoverDeterministicFalsePositiveIssues: true,
      }),
    ).rejects.toMatchObject({
      code: 'SKILL_OUTPUT_INVALID',
      message: expect.stringContaining('category_must_be_compliance'),
    });
  });

  it('accepts a Lieju contact block for an account value without a separator', async () => {
    const input = qualityInputWithTitleRule('广州搬家服务指南', 30, [
      { block_key: 'contact', text: '可添加QQ123456进一步咨询。' },
    ]);
    const output = blockedOutput({
      category: 'compliance',
      citation_ids: [],
      location: 'blocks[0].text',
      message: '正文包含QQ账号“QQ123456”。',
      rule_id: 'lieju.contact_in_content_forbidden',
      severity: 'BLOCK',
      suggestion: '删除QQ账号。',
    });
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [{ text: JSON.stringify(output) }],
    });

    await expect(
      skill(adapter).run({ context, input, recordUsage: () => undefined }),
    ).resolves.toMatchObject({ output: { data: { decision: 'block' } } });
  });

  it('rejects a company-name block for the generic phrase 电话公司', async () => {
    const input = qualityInputWithBlocks([
      { block_key: 'intro', text: '电话公司搬迁前应先确认线路和设备清单。' },
    ]);
    const output = blockedOutput({
      category: 'brand',
      citation_ids: [],
      location: 'blocks[0].text',
      message: '内容包含禁止的公司名称“电话公司”。',
      rule_id: 'brand.other_company_name',
      severity: 'BLOCK',
      suggestion: '改为匿名表述。',
    });
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [{ text: JSON.stringify(output) }],
    });

    await expect(
      skill(adapter).run({ context, input, recordUsage: () => undefined }),
    ).rejects.toMatchObject({
      code: 'SKILL_OUTPUT_INVALID',
      message: expect.stringContaining('"reason":"only_allowed_owner_or_generic_name_is_quoted"'),
    });
  });

  it('rejects a company-name block for the anonymous institution 某银行', async () => {
    const input = qualityInputWithBlocks([
      { block_key: 'intro', text: '可向某银行咨询企业结算流程。' },
    ]);
    const output = blockedOutput({
      category: 'brand',
      citation_ids: [],
      location: 'blocks[0].text',
      message: '内容包含禁止的公司名称“某银行”。',
      rule_id: 'brand.other_company_name',
      severity: 'BLOCK',
      suggestion: '改为匿名表述。',
    });

    await expect(
      skill(
        new MockModelAdapter({
          modelKey: 'flash',
          responses: [{ text: JSON.stringify(output) }],
        }),
      ).run({ context, input, recordUsage: () => undefined }),
    ).rejects.toMatchObject({
      code: 'SKILL_OUTPUT_INVALID',
      message: expect.stringContaining('only_allowed_owner_or_generic_name_is_quoted'),
    });
  });

  it.each(['设备清单', '某银行结算服务'])(
    'rejects a company-name block for non-identifiable quoted text %s',
    async (quotedText) => {
      const input = qualityInputWithBlocks([
        { block_key: 'intro', text: `文章建议核对${quotedText}。` },
      ]);
      const output = blockedOutput({
        category: 'brand',
        citation_ids: [],
        location: 'blocks[0].text',
        message: `内容包含禁止的公司名称“${quotedText}”。`,
        rule_id: 'brand.other_company_name',
        severity: 'BLOCK',
        suggestion: '改为匿名表述。',
      });

      await expect(
        skill(
          new MockModelAdapter({
            modelKey: 'flash',
            responses: [{ text: JSON.stringify(output) }],
          }),
        ).run({ context, input, recordUsage: () => undefined }),
      ).rejects.toMatchObject({
        code: 'SKILL_OUTPUT_INVALID',
        message: expect.stringContaining('quoted_name_is_not_identifiable_company'),
      });
    },
  );

  it('rejects a company-name block for the allowed owner company', async () => {
    const input = qualityInputWithBlocks(
      [
        {
          block_key: 'intro',
          text: '广州志远搬家服务有限公司可根据现场情况说明服务边界。',
        },
      ],
      { positioning: '广州志远搬家服务有限公司面向广州提供搬迁服务。' },
    );
    const output = blockedOutput({
      category: 'brand',
      citation_ids: [],
      location: 'blocks[0].text',
      message: '内容包含禁止的公司名称“广州志远搬家服务有限公司”。',
      rule_id: 'brand.other_company_name',
      severity: 'BLOCK',
      suggestion: '删除公司名称。',
    });
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [{ text: JSON.stringify(output) }],
    });

    await expect(
      skill(adapter).run({ context, input, recordUsage: () => undefined }),
    ).rejects.toMatchObject({
      code: 'SKILL_OUTPUT_INVALID',
      message: expect.stringContaining('"reason":"only_allowed_owner_or_generic_name_is_quoted"'),
    });
  });

  it('can recover an unverifiable owner-company block after model semantic repair', async () => {
    const input = qualityInputWithBlocks(
      [
        {
          block_key: 'intro',
          text: '广州志远搬家服务有限公司可根据现场情况说明服务边界。',
        },
      ],
      { positioning: '广州志远搬家服务有限公司面向广州提供搬迁服务。' },
    );
    const output = blockedOutput({
      category: 'brand',
      citation_ids: [],
      location: 'blocks[0].text',
      message: '内容包含禁止的公司名称“广州志远搬家服务有限公司”。',
      rule_id: 'brand.other_company_name',
      severity: 'BLOCK',
      suggestion: '删除公司名称。',
    });

    await expect(
      skill(
        new MockModelAdapter({
          modelKey: 'flash',
          responses: [{ text: JSON.stringify(output) }],
        }),
      ).run({
        context,
        input,
        recordUsage: () => undefined,
        recoverDeterministicFalsePositiveIssues: true,
      }),
    ).resolves.toMatchObject({
      output: { data: { decision: 'pass', issues: [] } },
    });
  });

  it('can recover an unverifiable generic-company block after model semantic repair', async () => {
    const input = qualityInputWithBlocks([
      { block_key: 'intro', text: '可向某银行咨询企业结算流程。' },
    ]);
    const output = blockedOutput({
      category: 'brand',
      citation_ids: [],
      location: 'blocks[0].text',
      message: '内容包含禁止的公司名称“某银行”。',
      rule_id: 'brand.other_company_name',
      severity: 'BLOCK',
      suggestion: '改为匿名表述。',
    });

    await expect(
      skill(
        new MockModelAdapter({
          modelKey: 'flash',
          responses: [{ text: JSON.stringify(output) }],
        }),
      ).run({
        context,
        input,
        recordUsage: () => undefined,
        recoverDeterministicFalsePositiveIssues: true,
      }),
    ).resolves.toMatchObject({
      output: { data: { decision: 'pass', issues: [] } },
    });
  });

  it('does not recover a verifiable prohibited third-party brand block', async () => {
    const input = qualityInputWithBlocks([{ block_key: 'intro', text: '可通过货拉拉安排运输。' }]);
    const output = blockedOutput({
      category: 'brand',
      citation_ids: [],
      location: 'blocks[0].text',
      message: '内容包含禁止的第三方品牌“货拉拉”。',
      rule_id: 'brand.other_company_name',
      severity: 'BLOCK',
      suggestion: '改为匿名表述。',
    });

    await expect(
      skill(
        new MockModelAdapter({
          modelKey: 'flash',
          responses: [{ text: JSON.stringify(output) }],
        }),
      ).run({
        context,
        input,
        recordUsage: () => undefined,
        recoverDeterministicFalsePositiveIssues: true,
      }),
    ).resolves.toMatchObject({
      output: {
        data: {
          decision: 'block',
          issues: [expect.objectContaining({ rule_id: 'brand.other_company_name' })],
        },
      },
    });
  });

  it('does not recover a malformed finding that may still target a prohibited brand', async () => {
    const input = qualityInputWithBlocks([{ block_key: 'intro', text: '可通过货拉拉安排运输。' }]);
    const output = blockedOutput({
      category: 'compliance',
      citation_ids: [],
      location: 'blocks[0].text',
      message: '内容包含禁止的第三方品牌“货拉拉”。',
      rule_id: 'brand.other_company_name',
      severity: 'BLOCK',
      suggestion: '改为匿名表述。',
    });

    await expect(
      skill(
        new MockModelAdapter({
          modelKey: 'flash',
          responses: [{ text: JSON.stringify(output) }],
        }),
      ).run({
        context,
        input,
        recordUsage: () => undefined,
        recoverDeterministicFalsePositiveIssues: true,
      }),
    ).rejects.toMatchObject({
      code: 'SKILL_OUTPUT_INVALID',
      message: expect.stringContaining('category_must_be_brand'),
    });
  });

  it('uses the current tenant published owner instead of the legacy global owner', async () => {
    const input = qualityInputWithBlocks(
      [
        {
          block_key: 'intro',
          text: '广州众人搬家起重吊装有限公司可根据现场情况说明服务边界，广州志远搬家服务有限公司不应出现在本文。',
        },
      ],
      { positioning: '广州众人搬家起重吊装有限公司面向广州提供搬迁服务。' },
    );
    const ownerOutput = blockedOutput({
      category: 'brand',
      citation_ids: [],
      location: 'blocks[0].text',
      message: '内容包含禁止的公司名称“广州众人搬家起重吊装有限公司”。',
      rule_id: 'brand.other_company_name',
      severity: 'BLOCK',
      suggestion: '删除公司名称。',
    });
    const competitorOutput = blockedOutput({
      category: 'brand',
      citation_ids: [],
      location: 'blocks[0].text',
      message: '内容包含禁止的公司名称“广州志远搬家服务有限公司”。',
      rule_id: 'brand.other_company_name',
      severity: 'BLOCK',
      suggestion: '删除公司名称。',
    });

    await expect(
      skill(
        new MockModelAdapter({
          modelKey: 'flash',
          responses: [{ text: JSON.stringify(ownerOutput) }],
        }),
      ).run({ context, input, recordUsage: () => undefined }),
    ).rejects.toMatchObject({
      code: 'SKILL_OUTPUT_INVALID',
      message: expect.stringContaining('only_allowed_owner_or_generic_name_is_quoted'),
    });
    await expect(
      skill(
        new MockModelAdapter({
          modelKey: 'flash',
          responses: [{ text: JSON.stringify(competitorOutput) }],
        }),
      ).run({ context, input, recordUsage: () => undefined }),
    ).resolves.toMatchObject({ output: { data: { decision: 'block' } } });
  });

  it('reports every unverifiable semantic issue in one rejection', async () => {
    const input = qualityInputWithTitleRule('广州搬家服务指南', 30, [
      { block_key: 'intro', text: '通过页面联系方式咨询具体需求。' },
    ]);
    const output = {
      ...fixture.output.data,
      decision: 'block',
      issues: [
        {
          category: 'brand',
          citation_ids: [],
          location: 'brand_policy.policy.cta',
          message: '内容包含禁止的公司名称“广州虚构搬家有限公司”。',
          rule_id: 'brand.other_company_name',
          severity: 'BLOCK',
          suggestion: '删除公司名称。',
        },
        {
          category: 'compliance',
          citation_ids: [],
          location: 'blocks[0].text',
          message: '正文包含联系方式。',
          rule_id: 'lieju.contact_in_content_forbidden',
          severity: 'BLOCK',
          suggestion: '删除联系方式。',
        },
      ],
      score: 35,
    };
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [{ text: JSON.stringify(output) }],
    });

    await expect(
      skill(adapter).run({ context, input, recordUsage: () => undefined }),
    ).rejects.toMatchObject({
      code: 'SKILL_OUTPUT_INVALID',
      message: expect.stringMatching(
        /location_does_not_resolve_to_content.*prohibited_contact_detail_is_not_present_at_location/u,
      ),
    });
  });

  it('rejects a company-name block that points to the wrong content location', async () => {
    const input = qualityInputWithBlocks([
      { block_key: 'intro', text: '工厂搬迁前应先确认设备清单。' },
      { block_key: 'comparison', text: '可通过货拉拉安排运输。' },
    ]);
    const output = blockedOutput({
      category: 'brand',
      citation_ids: [],
      location: 'blocks[0].text',
      message: '内容包含禁止的第三方品牌“货拉拉”。',
      rule_id: 'brand.other_company_name',
      severity: 'BLOCK',
      suggestion: '改为匿名表述。',
    });
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [{ text: JSON.stringify(output) }],
    });

    await expect(
      skill(adapter).run({ context, input, recordUsage: () => undefined }),
    ).rejects.toMatchObject({
      code: 'SKILL_OUTPUT_INVALID',
      message: expect.stringContaining(
        '"reason":"quoted_prohibited_name_is_not_present_at_location"',
      ),
    });
  });

  it('keeps an exact company-name block at the location containing the prohibited name', async () => {
    const input = qualityInputWithBlocks([{ block_key: 'intro', text: '可通过货拉拉安排运输。' }]);
    const output = blockedOutput({
      category: 'brand',
      citation_ids: [],
      location: 'blocks[0].text',
      message: '内容包含禁止的第三方品牌“货拉拉”。',
      rule_id: 'brand.other_company_name',
      severity: 'BLOCK',
      suggestion: '改为匿名表述。',
    });
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [{ text: JSON.stringify(output) }],
    });

    await expect(
      skill(adapter).run({ context, input, recordUsage: () => undefined }),
    ).resolves.toMatchObject({ output: { data: { decision: 'block' } } });
  });

  it('keeps an exact legal company name when ordinary words precede it in the sentence', async () => {
    const input = qualityInputWithBlocks([
      { block_key: 'intro', text: '可通过广州家盛搬家有限公司安排运输。' },
    ]);
    const output = blockedOutput({
      category: 'brand',
      citation_ids: [],
      location: 'blocks[0].text',
      message: '内容包含禁止的第三方企业“广州家盛搬家有限公司”。',
      rule_id: 'brand.other_company_name',
      severity: 'BLOCK',
      suggestion: '改为匿名表述。',
    });

    await expect(
      skill(
        new MockModelAdapter({ modelKey: 'flash', responses: [{ text: JSON.stringify(output) }] }),
      ).run({ context, input, recordUsage: () => undefined }),
    ).resolves.toMatchObject({ output: { data: { decision: 'block' } } });
  });

  it('runs through the real DeepSeek Adapter with JSON mode and four tools', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const baseUrl = await serve(async (incoming, outgoing) => {
      requestBody = JSON.parse(await body(incoming)) as Record<string, unknown>;
      outgoing.writeHead(200, { 'Content-Type': 'application/json' });
      outgoing.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              index: 0,
              message: { content: JSON.stringify(fixture.output.data), role: 'assistant' },
            },
          ],
          id: 'quality-provider-request',
          model: 'configured-provider-model',
          usage: { completion_tokens: 140, prompt_tokens: 380, total_tokens: 520 },
        }),
      );
    });
    const adapter = new DeepSeekModelAdapter({
      apiKey: 'test-secret',
      baseUrl,
      maxOutputTokens: 8_192,
      maxRetries: 0,
      modelKey: 'flash',
      providerModelId: 'configured-provider-model',
      retryBaseDelayMs: 0,
      timeoutMs: 2_000,
    });
    await expect(
      skill(adapter).run({
        context,
        input: fixture.input,
        prompt: {
          systemPrompt: '官网第一方经营事实以已发布品牌档案为准。',
          taskTemplate: '不得因为缺少公开链接要求企业重复确认。',
        },
        recordUsage: () => undefined,
      }),
    ).resolves.toMatchObject({ output: { skill_name: 'quality-checker' } });
    expect(requestBody).toMatchObject({ response_format: { type: 'json_object' }, temperature: 0 });
    expect(requestBody?.['tools']).toHaveLength(4);
    expect(JSON.stringify(requestBody?.['messages'])).toContain(
      'enterprise-approved first-party source',
    );
    expect(JSON.stringify(requestBody?.['messages'])).toContain(
      '不得因为缺少公开链接要求企业重复确认',
    );
  });
});

function rulesCall() {
  return {
    toolCalls: [
      {
        arguments: {
          platform_code: 'wechat_mp',
          version_id: '40000000-0000-4000-8000-000000000069',
        },
        id: 'rules-1',
        name: 'get_platform_rules',
      },
    ],
  };
}

function qualityInputWithBlocks(
  blocks: readonly Readonly<Record<string, unknown>>[],
  brandPolicy: Readonly<Record<string, unknown>> = {},
) {
  return {
    ...fixture.input,
    brand_policy: {
      ...(fixture.input['brand_policy'] as Readonly<Record<string, unknown>>),
      policy: {
        ...((fixture.input['brand_policy'] as Readonly<Record<string, unknown>>)[
          'policy'
        ] as Readonly<Record<string, unknown>>),
        ...brandPolicy,
      },
    },
    content_version: {
      ...(fixture.input['content_version'] as Readonly<Record<string, unknown>>),
      content: {
        blocks,
        platform_code: 'baijiahao',
        title: '广州工厂搬迁准备指南',
      },
    },
  };
}

function qualityInputWithTitleRule(
  title: string,
  titleMaxCharacters: number,
  blocks: readonly Readonly<Record<string, unknown>>[] = [
    {
      block_key: 'intro',
      text: '搬家前应先确认物品清单、服务范围和验收方式。',
    },
  ],
) {
  return {
    ...qualityInputWithBlocks(blocks),
    content_version: {
      ...(fixture.input['content_version'] as Readonly<Record<string, unknown>>),
      content: {
        blocks,
        platform_code: 'lieju',
        title,
      },
    },
    platform_rules: {
      ...(fixture.input['platform_rules'] as Readonly<Record<string, unknown>>),
      platform_code: 'lieju',
      rules: { contact_in_content_forbidden: true, title_max_characters: titleMaxCharacters },
    },
  };
}

function blockedOutput(issue: Readonly<Record<string, unknown>>) {
  return {
    ...fixture.output.data,
    decision: 'block',
    issues: [issue],
    score: 35,
  };
}

function skill(adapter: ConstructorParameters<typeof SkillRunner>[0]): QualityCheckerSkill {
  const schemas = new SchemaGuard();
  const definitions = [
    GET_PLATFORM_RULES_TOOL,
    SEARCH_KNOWLEDGE_TOOL,
    CREATE_QUALITY_ISSUE_TOOL,
    REQUEST_HUMAN_REVIEW_TOOL,
  ];
  return new QualityCheckerSkill(
    new SkillRunner(
      adapter,
      schemas,
      new ToolRegistry(
        definitions.map((definition) => tool(definition)),
        schemas,
      ),
    ),
  );
}
function tool(definition: {
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly name: string;
}): SkillTool {
  const execute: SkillTool['execute'] = (args) => args;
  return Object.freeze({
    allowedSkills: ['quality-checker'] as const,
    description: definition.description,
    execute,
    inputSchema: definition.inputSchema,
    name: definition.name,
  });
}
async function serve(
  handler: (incoming: IncomingMessage, outgoing: ServerResponse) => void | Promise<void>,
): Promise<string> {
  const server = createServer((incoming, outgoing) => {
    Promise.resolve(handler(incoming, outgoing)).catch((error: unknown) =>
      outgoing.destroy(error instanceof Error ? error : undefined),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  closers.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server address missing');
  return `http://127.0.0.1:${address.port}/v1`;
}
async function body(incoming: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
