export type SkillRuntimeErrorCode =
  | 'SKILL_CONTEXT_INVALID'
  | 'SKILL_INPUT_INVALID'
  | 'SKILL_MODEL_MISMATCH'
  | 'SKILL_OUTPUT_INVALID'
  | 'SKILL_TOOL_ARGUMENTS_INVALID'
  | 'SKILL_TOOL_EXECUTION_FAILED'
  | 'SKILL_TOOL_FORBIDDEN'
  | 'SKILL_TOOL_LIMIT_EXCEEDED'
  | 'SKILL_TOOL_NOT_FOUND';

export class SkillRuntimeError extends Error {
  public constructor(
    public readonly code: SkillRuntimeErrorCode,
    message: string,
    public readonly paths: readonly string[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SkillRuntimeError';
  }
}
