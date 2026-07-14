import {
  QUALITY_CHECKER_DATA_SCHEMA,
  QUALITY_CHECKER_INPUT_SCHEMA,
  QUALITY_CHECKER_OUTPUT_SCHEMA,
  QUALITY_CHECKER_SKILL_NAME,
  QUALITY_CHECKER_SKILL_VERSION,
} from '../../../../contracts/src/skills/quality-checker/index.js';
import { QUALITY_CHECKER_FEW_SHOTS_V1 } from './few-shots.js';
import {
  QUALITY_CHECKER_PROMPT_VERSION,
  QUALITY_CHECKER_SYSTEM_PROMPT_V1,
  QUALITY_CHECKER_TASK_PROMPT_V1,
} from './prompt.js';

export const QUALITY_CHECKER_TOOL_NAMES_V1 = Object.freeze([
  'search_knowledge',
  'get_platform_rules',
  'create_quality_issue',
  'request_human_review',
] as const);

export const QUALITY_CHECKER_CONTRACT_V1 = Object.freeze({
  dataSchema: QUALITY_CHECKER_DATA_SCHEMA,
  fewShots: QUALITY_CHECKER_FEW_SHOTS_V1,
  inputSchema: QUALITY_CHECKER_INPUT_SCHEMA,
  outputSchema: QUALITY_CHECKER_OUTPUT_SCHEMA,
  prompt: Object.freeze({
    system: QUALITY_CHECKER_SYSTEM_PROMPT_V1,
    task: QUALITY_CHECKER_TASK_PROMPT_V1,
    version: QUALITY_CHECKER_PROMPT_VERSION,
  }),
  skillName: QUALITY_CHECKER_SKILL_NAME,
  skillVersion: QUALITY_CHECKER_SKILL_VERSION,
  toolNames: QUALITY_CHECKER_TOOL_NAMES_V1,
});

export * from './few-shots.js';
export * from './prompt.js';
