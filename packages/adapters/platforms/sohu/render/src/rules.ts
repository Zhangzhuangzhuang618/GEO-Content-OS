import { SOHU_RENDER_RULE_VERSION } from './types.js';

export const SOHU_RENDER_RULES_V1 = Object.freeze({
  abstract: Object.freeze({ maximumCharacters: 120, minimumCharacters: 1 }),
  aiGenerated: true,
  original: false,
  requiredBodySegments: 5,
  title: Object.freeze({ maximumCharacters: 72, minimumCharacters: 5 }),
  version: SOHU_RENDER_RULE_VERSION,
});
