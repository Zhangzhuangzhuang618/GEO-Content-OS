import { createRequestUuid } from '@/lib/request-uuid';

import {
  PromptPageResponseSchema,
  PromptResponseSchema,
  RulePageResponseSchema,
  RuleResponseSchema,
  type PlatformCode,
  type PromptVersion,
  type RuleVersion,
  type SkillName,
} from './platform-config.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export interface PlatformConfigFilters {
  readonly platform: string;
  readonly skill: string;
  readonly status: string;
}

export async function listPlatformConfig(filters: PlatformConfigFilters, signal?: AbortSignal) {
  const promptQuery = new URLSearchParams({ limit: '100' });
  const ruleQuery = new URLSearchParams({ limit: '100' });
  if (filters.skill) promptQuery.set('skill_name', filters.skill);
  if (filters.platform) ruleQuery.set('platform_code', filters.platform);
  if (filters.status) {
    promptQuery.set('status', filters.status);
    ruleQuery.set('status', filters.status);
  }
  const [prompts, rules] = await Promise.all([
    read(`/api/v1/platform/prompt-versions?${promptQuery}`, PromptPageResponseSchema, signal),
    read(`/api/v1/platform/rule-versions?${ruleQuery}`, RulePageResponseSchema, signal),
  ]);
  return { prompts: prompts.data.items, rules: rules.data.items };
}

export async function createPrompt(
  input: {
    readonly changeSummary: string;
    readonly schemaVersion: string;
    readonly semanticVersion: string;
    readonly skillName: SkillName;
    readonly systemPrompt: string;
    readonly taskTemplate: string;
  },
  csrf: string,
): Promise<PromptVersion> {
  const response = await fetch(`${API_ORIGIN}/api/v1/platform/prompt-versions`, {
    body: JSON.stringify({
      change_summary: input.changeSummary.trim(),
      schema_version: input.schemaVersion.trim(),
      semantic_version: input.semanticVersion.trim(),
      skill_name: input.skillName,
      system_prompt: input.systemPrompt.trim(),
      task_template: input.taskTemplate.trim(),
    }),
    credentials: 'include',
    headers: createHeaders(csrf, 'prompt-version-create'),
    method: 'POST',
  });
  return parseMutation(response, PromptResponseSchema);
}

export async function createRule(
  input: {
    readonly changeSummary: string;
    readonly platformCode: PlatformCode;
    readonly rules: Record<string, unknown>;
    readonly semanticVersion: string;
  },
  csrf: string,
): Promise<RuleVersion> {
  const response = await fetch(`${API_ORIGIN}/api/v1/platform/rule-versions`, {
    body: JSON.stringify({
      change_summary: input.changeSummary.trim(),
      platform_code: input.platformCode,
      rules: input.rules,
      semantic_version: input.semanticVersion.trim(),
    }),
    credentials: 'include',
    headers: createHeaders(csrf, 'rule-version-create'),
    method: 'POST',
  });
  return parseMutation(response, RuleResponseSchema);
}

export async function transitionPrompt(
  item: PromptVersion,
  action: 'publish' | 'retire',
  csrf: string,
  reason?: string,
): Promise<PromptVersion> {
  return transition(
    `/api/v1/platform/prompt-versions/${item.id}/${action}`,
    item,
    action,
    csrf,
    reason,
    PromptResponseSchema,
  );
}

export async function transitionRule(
  item: RuleVersion,
  action: 'publish' | 'retire',
  csrf: string,
  reason?: string,
): Promise<RuleVersion> {
  return transition(
    `/api/v1/platform/rule-versions/${item.id}/${action}`,
    item,
    action,
    csrf,
    reason,
    RuleResponseSchema,
  );
}

export class PlatformConfigRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Platform configuration request failed');
    this.name = 'PlatformConfigRequestError';
  }
}

async function read<T>(
  path: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new PlatformConfigRequestError(response.status);
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new PlatformConfigRequestError(502);
  return parsed.data;
}

async function transition<T extends { readonly version: number }>(
  path: string,
  item: T,
  action: 'publish' | 'retire',
  csrf: string,
  reason: string | undefined,
  schema: {
    safeParse(value: unknown): { success: true; data: { data: T } } | { success: false };
  },
): Promise<T> {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    body: JSON.stringify(action === 'publish' ? { version: item.version } : { reason }),
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'if-match': `"${item.version}"`,
      'x-csrf-token': csrf,
    },
    method: 'POST',
  });
  return parseMutation(response, schema);
}

async function parseMutation<T>(
  response: Response,
  schema: {
    safeParse(value: unknown): { success: true; data: { data: T } } | { success: false };
  },
): Promise<T> {
  if (!response.ok) throw new PlatformConfigRequestError(response.status);
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new PlatformConfigRequestError(502);
  return parsed.data.data;
}

function createHeaders(csrf: string, operation: string) {
  return {
    'content-type': 'application/json',
    'idempotency-key': `${operation}-${createRequestUuid()}`,
    'x-csrf-token': csrf,
  };
}
