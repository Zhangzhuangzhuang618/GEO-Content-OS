export const ERROR_CODES = Object.freeze([
  'AUTH_REQUIRED',
  'CSRF_INVALID',
  'TENANT_CONTEXT_REQUIRED',
  'RESOURCE_NOT_FOUND',
  'PERMISSION_DENIED',
  'STATE_TRANSITION_INVALID',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'QUALITY_BLOCKED',
  'BUDGET_EXCEEDED',
  'SCHEMA_VALIDATION_FAILED',
  'ADAPTER_CAPABILITY_UNAVAILABLE',
  'ADAPTER_AUTH_EXPIRED',
  'BROWSER_GATEWAY_UNAVAILABLE',
  'RATE_LIMITED',
  'AI_PROVIDER_TIMEOUT',
  'WENTIAN_CONNECTOR_NOT_CONFIGURED',
  'WENTIAN_CONNECTOR_UNAVAILABLE',
  'WENTIAN_BINDING_CONFLICT',
] as const);

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_DEFINITIONS = {
  AUTH_REQUIRED: { httpStatus: 401, message: '没有有效会话' },
  CSRF_INVALID: { httpStatus: 403, message: 'CSRF token 缺失或不匹配' },
  TENANT_CONTEXT_REQUIRED: { httpStatus: 403, message: '会话未选择有效租户' },
  RESOURCE_NOT_FOUND: {
    httpStatus: 404,
    message: '资源不存在或不在当前授权范围；统一避免枚举泄露',
  },
  PERMISSION_DENIED: { httpStatus: 403, message: '资源可见但角色不允许该动作' },
  STATE_TRANSITION_INVALID: { httpStatus: 409, message: '状态转换不允许' },
  VERSION_CONFLICT: { httpStatus: 409, message: '乐观锁版本冲突' },
  IDEMPOTENCY_CONFLICT: { httpStatus: 409, message: '相同幂等键使用了不同请求体' },
  QUALITY_BLOCKED: { httpStatus: 422, message: '质量门禁未通过' },
  BUDGET_EXCEEDED: { httpStatus: 402, message: '租户或任务预算不足' },
  SCHEMA_VALIDATION_FAILED: { httpStatus: 422, message: 'DTO 或 Skill JSON Schema 校验失败' },
  ADAPTER_CAPABILITY_UNAVAILABLE: {
    httpStatus: 422,
    message: '账号或平台不支持所请求能力',
  },
  ADAPTER_AUTH_EXPIRED: { httpStatus: 424, message: '平台凭证失效' },
  BROWSER_GATEWAY_UNAVAILABLE: { httpStatus: 503, message: '托管浏览器服务暂时不可用' },
  RATE_LIMITED: { httpStatus: 429, message: '限流；返回 Retry-After' },
  AI_PROVIDER_TIMEOUT: { httpStatus: 504, message: '模型调用超时' },
  WENTIAN_CONNECTOR_NOT_CONFIGURED: {
    httpStatus: 503,
    message: '当前租户尚未配置问天连接器',
  },
  WENTIAN_CONNECTOR_UNAVAILABLE: {
    httpStatus: 502,
    message: '问天连接器暂时不可用',
  },
  WENTIAN_BINDING_CONFLICT: {
    httpStatus: 409,
    message: '当前项目已有待确认或有效的问天绑定',
  },
} as const satisfies Record<ErrorCode, { httpStatus: number; message: string }>;

export function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(ERROR_DEFINITIONS, value);
}
