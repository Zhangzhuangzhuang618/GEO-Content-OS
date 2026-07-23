import {
  FACT_CHECKER_DATA_SCHEMA,
  FACT_CHECKER_INPUT_SCHEMA,
  FACT_CHECKER_OUTPUT_SCHEMA,
  FACT_CHECKER_SKILL_NAME,
  FACT_CHECKER_SKILL_VERSION,
} from '@geo-content-os/contracts/skills';
import { FACT_CHECKER_FEW_SHOTS_V1 } from './few-shots.js';
import {
  FACT_CHECKER_PROMPT_VERSION,
  FACT_CHECKER_SYSTEM_PROMPT_V1,
  FACT_CHECKER_TASK_PROMPT_V1,
} from './prompt.js';

export const FACT_CHECKER_TOOL_NAMES_V1 = Object.freeze([
  'search_knowledge',
  'request_human_review',
] as const);

export const FACT_CHECKER_CONTRACT_V1 = Object.freeze({
  dataSchema: FACT_CHECKER_DATA_SCHEMA,
  fewShots: FACT_CHECKER_FEW_SHOTS_V1,
  inputSchema: FACT_CHECKER_INPUT_SCHEMA,
  outputSchema: FACT_CHECKER_OUTPUT_SCHEMA,
  prompt: Object.freeze({
    system: FACT_CHECKER_SYSTEM_PROMPT_V1,
    task: FACT_CHECKER_TASK_PROMPT_V1,
    version: FACT_CHECKER_PROMPT_VERSION,
  }),
  skillName: FACT_CHECKER_SKILL_NAME,
  skillVersion: FACT_CHECKER_SKILL_VERSION,
  toolNames: FACT_CHECKER_TOOL_NAMES_V1,
});

export * from './few-shots.js';
export * from './prompt.js';
