import { BAIJIAHAO_RENDER_RULE_VERSION } from './types.js';

export const BAIJIAHAO_RENDER_RULES_V1 = Object.freeze({
  abstract: Object.freeze({ maximumCharacters: 120, minimumCharacters: 1 }),
  ambiguousTimeMarkers: Object.freeze([
    '今天',
    '昨天',
    '明天',
    '近日',
    '近期',
    '今年',
    '去年',
    '明年',
    '本月',
    '上月',
    '下月',
  ]),
  platformCode: 'baijiahao',
  requiredBodySegments: 2,
  requiredPlatformMeta: Object.freeze(['abstract', 'tags', 'content_type']),
  tags: Object.freeze({ maximumItems: 8, minimumItems: 3 }),
  title: Object.freeze({ maximumCharacters: 40, minimumCharacters: 2 }),
  version: BAIJIAHAO_RENDER_RULE_VERSION,
});
