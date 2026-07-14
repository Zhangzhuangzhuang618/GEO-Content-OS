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
