import {
  CONTENT_WRITER_DATA_SCHEMA,
  CONTENT_WRITER_INPUT_SCHEMA,
  CONTENT_WRITER_OUTPUT_SCHEMA,
  CONTENT_WRITER_SKILL_NAME,
  CONTENT_WRITER_SKILL_VERSION,
} from '@geo-content-os/contracts/skills';
import { CONTENT_WRITER_FEW_SHOTS_V1 } from './few-shots.js';
import {
  CONTENT_WRITER_PLATFORM_PROMPTS_V1,
  CONTENT_WRITER_PROMPT_VERSION,
  CONTENT_WRITER_SYSTEM_PROMPT_V1,
  CONTENT_WRITER_TASK_PROMPT_V1,
} from './prompt.js';

export const CONTENT_WRITER_TOOL_NAMES_V1 = Object.freeze([
  'get_strategy_version',
  'get_platform_rules',
] as const);

export const CONTENT_WRITER_CONTRACT_V1 = Object.freeze({
  dataSchema: CONTENT_WRITER_DATA_SCHEMA,
  fewShots: CONTENT_WRITER_FEW_SHOTS_V1,
  inputSchema: CONTENT_WRITER_INPUT_SCHEMA,
  outputSchema: CONTENT_WRITER_OUTPUT_SCHEMA,
  platformPrompts: CONTENT_WRITER_PLATFORM_PROMPTS_V1,
  prompt: Object.freeze({
    system: CONTENT_WRITER_SYSTEM_PROMPT_V1,
    task: CONTENT_WRITER_TASK_PROMPT_V1,
    version: CONTENT_WRITER_PROMPT_VERSION,
  }),
  skillName: CONTENT_WRITER_SKILL_NAME,
  skillVersion: CONTENT_WRITER_SKILL_VERSION,
  toolNames: CONTENT_WRITER_TOOL_NAMES_V1,
});

export * from './few-shots.js';
export * from './prompt.js';
