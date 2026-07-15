import { XIAOHONGSHU_PLATFORM_CODE, XIAOHONGSHU_RENDER_RULE_VERSION } from './types.js';

export const XIAOHONGSHU_RENDER_RULES_V1 = Object.freeze({
  experienceClaimMarkers: Object.freeze(['我亲测', '本人亲测', '亲身体验', '我用了', '实测有效']),
  paragraphMaximumCharacters: 120,
  platformCode: XIAOHONGSHU_PLATFORM_CODE,
  requiredPlatformMeta: Object.freeze(['topics', 'cover_text', 'note_type']),
  title: Object.freeze({ maximumCharacters: 20, minimumCharacters: 2 }),
  version: XIAOHONGSHU_RENDER_RULE_VERSION,
});
