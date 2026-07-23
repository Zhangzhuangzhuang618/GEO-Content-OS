export const PLATFORM_ROLE_CODES = Object.freeze(['platform_admin', 'platform_operator'] as const);

export type PlatformRoleCode = (typeof PLATFORM_ROLE_CODES)[number];

export const TENANT_ROLE_CODES = Object.freeze([
  'tenant_owner',
  'tenant_admin',
  'strategy_editor',
  'content_editor',
  'reviewer',
  'publisher',
  'analyst',
  'viewer',
] as const);

export type TenantRoleCode = (typeof TENANT_ROLE_CODES)[number];
export type RoleCode = PlatformRoleCode | TenantRoleCode;

export const ROLE_DEFINITIONS = {
  platform_admin: '平台租户、全局模型/费率、系统审计；租户内容访问必须有支持授权',
  platform_operator: '平台规则、Prompt 发布和运行监控；默认不能读取租户内容',
  tenant_owner: '账单、成员、工作区和全部租户资源',
  tenant_admin: '成员、工作区、平台账号、策略和全部内容',
  strategy_editor: '品牌、关键词、主题、资料和 Brief',
  content_editor: '内容包、生成、编辑、质量检查和提交审核',
  reviewer: '审核列表、证据、通过、退回和加签',
  publisher: '平台账号、排期、发布、重试和导出',
  analyst: '指标、可见性、成本和导出',
  viewer: '授权工作区内只读',
} as const satisfies Record<RoleCode, string>;
