import {
  MATERIAL_PARSER_DATA_SCHEMA,
  MATERIAL_PARSER_INPUT_SCHEMA,
  MATERIAL_PARSER_OUTPUT_SCHEMA,
  MATERIAL_PARSER_SKILL_NAME,
  MATERIAL_PARSER_SKILL_VERSION,
} from '../../../../contracts/src/skills/material-parser/index.js';
import { MATERIAL_PARSER_FEW_SHOTS_V1 } from './few-shots.js';
import {
  MATERIAL_PARSER_PROMPT_VERSION,
  MATERIAL_PARSER_SYSTEM_PROMPT_V1,
  MATERIAL_PARSER_TASK_PROMPT_V1,
} from './prompt.js';

export const MATERIAL_PARSER_TOOL_NAMES_V1 = Object.freeze([] as const);

export const MATERIAL_PARSER_CONTRACT_V1 = Object.freeze({
  dataSchema: MATERIAL_PARSER_DATA_SCHEMA,
  fewShots: MATERIAL_PARSER_FEW_SHOTS_V1,
  inputSchema: MATERIAL_PARSER_INPUT_SCHEMA,
  outputSchema: MATERIAL_PARSER_OUTPUT_SCHEMA,
  prompt: Object.freeze({
    system: MATERIAL_PARSER_SYSTEM_PROMPT_V1,
    task: MATERIAL_PARSER_TASK_PROMPT_V1,
    version: MATERIAL_PARSER_PROMPT_VERSION,
  }),
  skillName: MATERIAL_PARSER_SKILL_NAME,
  skillVersion: MATERIAL_PARSER_SKILL_VERSION,
  toolNames: MATERIAL_PARSER_TOOL_NAMES_V1,
});

export * from './few-shots.js';
export * from './prompt.js';
