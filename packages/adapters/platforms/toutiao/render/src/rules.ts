import { TOUTIAO_RENDER_RULE_VERSION } from './types.js';

export const TOUTIAO_RENDER_RULES_V1 = Object.freeze({
  clickbaitTitleMarkers: Object.freeze(['震惊', '惊呆', '必看', '速看', '不看后悔', '万万没想到']),
  lead: Object.freeze({ maximumCharacters: 100, minimumCharacters: 1 }),
  platformCode: 'toutiao',
  requiredPlatformMeta: Object.freeze(['lead', 'tags', 'content_type']),
  timeSensitiveMarkers: Object.freeze([
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
    '最新',
    '目前',
  ]),
  title: Object.freeze({ maximumCharacters: 50, minimumCharacters: 2 }),
  version: TOUTIAO_RENDER_RULE_VERSION,
});
