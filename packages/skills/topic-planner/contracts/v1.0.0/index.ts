import {
  TOPIC_PLANNER_DATA_SCHEMA,
  TOPIC_PLANNER_INPUT_SCHEMA,
  TOPIC_PLANNER_OUTPUT_SCHEMA,
  TOPIC_PLANNER_SKILL_NAME,
  TOPIC_PLANNER_SKILL_VERSION,
} from '@geo-content-os/contracts/skills';
import { TOPIC_PLANNER_FEW_SHOTS_V1 } from './few-shots.js';
import {
  TOPIC_PLANNER_PROMPT_VERSION,
  TOPIC_PLANNER_SYSTEM_PROMPT_V1,
  TOPIC_PLANNER_TASK_PROMPT_V1,
} from './prompt.js';

export const TOPIC_PLANNER_TOOL_NAMES_V1 = Object.freeze([
  'get_strategy_version',
  'search_knowledge',
] as const);

export const TOPIC_PLANNER_CONTRACT_V1 = Object.freeze({
  dataSchema: TOPIC_PLANNER_DATA_SCHEMA,
  fewShots: TOPIC_PLANNER_FEW_SHOTS_V1,
  inputSchema: TOPIC_PLANNER_INPUT_SCHEMA,
  outputSchema: TOPIC_PLANNER_OUTPUT_SCHEMA,
  prompt: Object.freeze({
    system: TOPIC_PLANNER_SYSTEM_PROMPT_V1,
    task: TOPIC_PLANNER_TASK_PROMPT_V1,
    version: TOPIC_PLANNER_PROMPT_VERSION,
  }),
  skillName: TOPIC_PLANNER_SKILL_NAME,
  skillVersion: TOPIC_PLANNER_SKILL_VERSION,
  toolNames: TOPIC_PLANNER_TOOL_NAMES_V1,
});

export * from './few-shots.js';
export * from './prompt.js';
