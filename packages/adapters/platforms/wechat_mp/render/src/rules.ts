import { WECHAT_MP_PLATFORM_CODE, WECHAT_MP_RENDER_RULE_VERSION } from './types.js';

export const WECHAT_MP_RENDER_RULES_V1 = Object.freeze({
  paragraphMaximumCharacters: 300,
  platformCode: WECHAT_MP_PLATFORM_CODE,
  requiredPlatformMeta: Object.freeze(['digest', 'author', 'cover_asset_id']),
  title: Object.freeze({ maximumCharacters: 64, minimumCharacters: 2 }),
  version: WECHAT_MP_RENDER_RULE_VERSION,
});
