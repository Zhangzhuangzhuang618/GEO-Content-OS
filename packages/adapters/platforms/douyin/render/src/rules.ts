import { DOUYIN_PLATFORM_CODE, DOUYIN_RENDER_RULE_VERSION } from './types.js';

export const DOUYIN_RENDER_RULES_V1 = Object.freeze({
  hookMaximumSeconds: 3,
  platformCode: DOUYIN_PLATFORM_CODE,
  productionClaimMarkers: Object.freeze([
    '视频已制作',
    '视频制作完成',
    '成片已完成',
    '视频已发布',
    '已生成视频',
    '已拍摄完成',
  ]),
  requiredPlatformMeta: Object.freeze([
    'duration_seconds',
    'storyboard',
    'subtitles',
    'topics',
  ]),
  version: DOUYIN_RENDER_RULE_VERSION,
});
