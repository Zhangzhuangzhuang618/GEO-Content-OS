import {
  GEO_OPTIMIZER_DATA_SCHEMA,
  GEO_OPTIMIZER_INPUT_SCHEMA,
  GEO_OPTIMIZER_OUTPUT_SCHEMA,
  GEO_OPTIMIZER_SKILL_NAME,
  GEO_OPTIMIZER_SKILL_VERSION,
} from '@geo-content-os/contracts/skills';
import { GEO_OPTIMIZER_FEW_SHOTS_V1 } from './few-shots.js';
import {
  GEO_OPTIMIZER_PROMPT_VERSION,
  GEO_OPTIMIZER_SYSTEM_PROMPT_V1,
  GEO_OPTIMIZER_TASK_PROMPT_V1,
} from './prompt.js';

export const GEO_OPTIMIZER_TOOL_NAMES_V1 = Object.freeze([
  'get_strategy_version',
  'get_platform_rules',
  'search_knowledge',
] as const);

export const GEO_OPTIMIZER_CONTRACT_V1 = Object.freeze({
  dataSchema: GEO_OPTIMIZER_DATA_SCHEMA,
  fewShots: GEO_OPTIMIZER_FEW_SHOTS_V1,
  inputSchema: GEO_OPTIMIZER_INPUT_SCHEMA,
  outputSchema: GEO_OPTIMIZER_OUTPUT_SCHEMA,
  prompt: Object.freeze({
    system: GEO_OPTIMIZER_SYSTEM_PROMPT_V1,
    task: GEO_OPTIMIZER_TASK_PROMPT_V1,
    version: GEO_OPTIMIZER_PROMPT_VERSION,
  }),
  skillName: GEO_OPTIMIZER_SKILL_NAME,
  skillVersion: GEO_OPTIMIZER_SKILL_VERSION,
  toolNames: GEO_OPTIMIZER_TOOL_NAMES_V1,
});

export * from './few-shots.js';
export * from './prompt.js';
