import type { JsonSchema } from './schema.types.js';

export interface SkillToolDefinitionContract {
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly name: string;
}

export const GET_STRATEGY_VERSION_TOOL: SkillToolDefinitionContract = Object.freeze({
  description: '获取当前工作区内已发布的品牌策略版本',
  inputSchema: Object.freeze({
    additionalProperties: false,
    properties: {
      brand_profile_id: { format: 'uuid', type: 'string' },
    },
    required: ['brand_profile_id'],
    type: 'object',
  }),
  name: 'get_strategy_version',
});

export const GET_PLATFORM_RULES_TOOL: SkillToolDefinitionContract = Object.freeze({
  description: '读取指定不可变平台规则版本',
  inputSchema: Object.freeze({
    additionalProperties: false,
    properties: {
      platform_code: {
        enum: [
          'official_site',
          'baijiahao',
          'toutiao',
          'zhihu',
          'xiaohongshu',
          'wechat_mp',
          'douyin',
        ],
      },
      version_id: { format: 'uuid', type: 'string' },
    },
    required: ['platform_code', 'version_id'],
    type: 'object',
  }),
  name: 'get_platform_rules',
});

export const SEARCH_KNOWLEDGE_TOOL: SkillToolDefinitionContract = Object.freeze({
  description: '在当前 tenant/workspace 范围内混合检索可信资料',
  inputSchema: Object.freeze({
    additionalProperties: false,
    properties: {
      project_id: { format: 'uuid', type: ['string', 'null'] },
      query: { minLength: 2, type: 'string' },
      top_k: { maximum: 20, minimum: 1, type: 'integer' },
      trust_levels: { items: { enum: ['verified', 'normal'] }, type: 'array' },
      workspace_id: { format: 'uuid', type: 'string' },
    },
    required: ['query', 'workspace_id', 'top_k'],
    type: 'object',
  }),
  name: 'search_knowledge',
});

export const REQUEST_HUMAN_REVIEW_TOOL: SkillToolDefinitionContract = Object.freeze({
  description: '创建人工事实裁决待办，不改变内容或发布状态',
  inputSchema: Object.freeze({
    additionalProperties: false,
    properties: {
      claim_keys: { items: { type: 'string' }, minItems: 1, type: 'array' },
      reason: { type: 'string' },
      risk_level: { enum: ['high', 'critical'] },
    },
    required: ['risk_level', 'reason', 'claim_keys'],
    type: 'object',
  }),
  name: 'request_human_review',
});
