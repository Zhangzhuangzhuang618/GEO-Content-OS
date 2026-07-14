import { UuidSchema } from '@geo-content-os/contracts';

import { SkillRuntimeError } from './skill-runtime.errors.js';

export const SKILL_NAMES = Object.freeze([
  'material-parser',
  'content-writer',
  'fact-checker',
  'topic-planner',
  'geo-optimizer',
  'quality-checker',
] as const);

export type SkillName = (typeof SKILL_NAMES)[number];

export interface SkillContext {
  readonly inputHash: string;
  readonly modelKey: string;
  readonly projectId: string | null;
  readonly promptVersionId: string;
  readonly requestId: string;
  readonly runId: string;
  readonly skillName: SkillName;
  readonly skillVersion: string;
  readonly tenantId: string;
  readonly workspaceId: string;
}

export function createSkillContext(input: SkillContext): SkillContext {
  try {
    UuidSchema.parse(input.tenantId);
    UuidSchema.parse(input.workspaceId);
    UuidSchema.parse(input.runId);
    UuidSchema.parse(input.promptVersionId);
    if (input.projectId !== null) UuidSchema.parse(input.projectId);
  } catch (error) {
    throw new SkillRuntimeError(
      'SKILL_CONTEXT_INVALID',
      'Skill scope contains an invalid UUID',
      [],
      {
        cause: error,
      },
    );
  }
  if (
    !SKILL_NAMES.includes(input.skillName) ||
    !/^\d+\.\d+\.\d+$/u.test(input.skillVersion) ||
    !/^[a-f0-9]{64}$/u.test(input.inputHash) ||
    input.requestId.length < 16 ||
    input.requestId.length > 160 ||
    !identifier(input.modelKey, 80)
  ) {
    throw new SkillRuntimeError('SKILL_CONTEXT_INVALID', 'Skill context is invalid');
  }
  return Object.freeze({ ...input });
}

function identifier(value: string, maximum: number): boolean {
  return value.length <= maximum && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value);
}
