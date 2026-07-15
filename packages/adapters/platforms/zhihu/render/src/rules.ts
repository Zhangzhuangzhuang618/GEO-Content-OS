import { ZHIHU_PLATFORM_CODE, ZHIHU_RENDER_RULE_VERSION } from './types.js';

export const ZHIHU_RENDER_RULES_V1 = Object.freeze({
  boundaryMarkers: Object.freeze(['边界', '限制', '不适用', '例外', '反例']),
  marketingMarkers: Object.freeze([
    '行业第一',
    '绝对领先',
    '完美解决',
    '颠覆行业',
    '闭眼入',
    '立即抢购',
    '不容错过',
  ]),
  platformCode: ZHIHU_PLATFORM_CODE,
  requiredPlatformMeta: Object.freeze(['question_id', 'content_type', 'topics']),
  version: ZHIHU_RENDER_RULE_VERSION,
});
