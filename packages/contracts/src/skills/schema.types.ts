export type JsonSchemaPrimitive = boolean | null | number | string;
export type JsonSchemaValue = JsonSchemaPrimitive | JsonSchema | readonly JsonSchemaValue[];
export interface JsonSchema {
  readonly [key: string]: JsonSchemaValue;
}

export const SKILL_RESULT_STATUSES = Object.freeze(['success', 'partial', 'failed'] as const);

export type SkillResultStatus = (typeof SKILL_RESULT_STATUSES)[number];

export interface SkillIssue {
  readonly code: string;
  readonly message: string;
  readonly path?: string | null;
}

export interface SkillCitation {
  readonly chunk_id: string;
  readonly quote_text: string;
  readonly source_id: string;
}

export interface SkillUsage {
  readonly cost_cents: number;
  readonly input_tokens: number;
  readonly model_key: string;
  readonly output_tokens: number;
  readonly provider: string;
}

export interface SkillTrace {
  readonly input_hash: string;
  readonly prompt_version_id: string;
  readonly request_id: string;
  readonly run_id: string;
}

export interface SkillResult<TData, TSkillName extends string = string> {
  readonly blockers: readonly SkillIssue[];
  readonly citations: readonly SkillCitation[];
  readonly data: TData;
  readonly skill_name: TSkillName;
  readonly skill_version: string;
  readonly status: SkillResultStatus;
  readonly trace: SkillTrace;
  readonly usage: SkillUsage;
  readonly warnings: readonly SkillIssue[];
}
