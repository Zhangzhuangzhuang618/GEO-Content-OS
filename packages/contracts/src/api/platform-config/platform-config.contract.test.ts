import { describe, expect, it } from 'vitest';

import {
  CreatePromptVersionRequestSchema,
  CreateRuleVersionRequestSchema,
  PLATFORM_CONFIG_API_CONTRACTS,
  PLATFORM_CONFIG_OPENAPI_DOCUMENT,
} from './index.js';

describe('platform config API contract', () => {
  it('freezes eight platform operator endpoints', () => {
    expect(PLATFORM_CONFIG_API_CONTRACTS.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /platform/prompt-versions',
      'POST /platform/prompt-versions',
      'POST /platform/prompt-versions/{id}/publish',
      'POST /platform/prompt-versions/{id}/retire',
      'GET /platform/rule-versions',
      'POST /platform/rule-versions',
      'POST /platform/rule-versions/{id}/publish',
      'POST /platform/rule-versions/{id}/retire',
    ]);
    expect(PLATFORM_CONFIG_OPENAPI_DOCUMENT.openapi).toBe('3.1.0');
    expect(
      Object.values(PLATFORM_CONFIG_OPENAPI_DOCUMENT.paths).flatMap((path) => Object.values(path)),
    ).toHaveLength(8);
  });

  it('requires semantic versions, compatible schemas and change summaries', () => {
    expect(
      CreatePromptVersionRequestSchema.safeParse({
        change_summary: 'Add evidence rules',
        schema_version: 'content-writer-data@1',
        semantic_version: '1.2.0',
        skill_name: 'content-writer',
        system_prompt: 'Use only supplied evidence.',
        task_template: 'Write {{brief}}.',
      }).success,
    ).toBe(true);
    expect(
      CreateRuleVersionRequestSchema.safeParse({
        change_summary: 'Set title limits',
        platform_code: 'zhihu',
        rules: { schema_version: 'platform-rules@1', title_max: 60 },
        semantic_version: 'invalid',
      }).success,
    ).toBe(false);
  });
});
