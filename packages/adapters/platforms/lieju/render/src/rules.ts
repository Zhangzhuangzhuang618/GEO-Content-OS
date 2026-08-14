import { LIEJU_RENDER_RULE_VERSION } from './types.js';

export const LIEJU_RENDER_RULES_V1 = Object.freeze({
  body: Object.freeze({ maximumCharacters: 8_000, minimumCharacters: 600 }),
  requiredBodySegments: 5,
  title: Object.freeze({ maximumCharacters: 30, minimumCharacters: 5 }),
  version: LIEJU_RENDER_RULE_VERSION,
});
