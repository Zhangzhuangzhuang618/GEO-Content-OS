import { describe, expect, it } from 'vitest';

import {
  browserPlatformGenerationModelKey,
  candidateLimitAttentionMessage,
  douyinDailyDecisionAngle,
} from './browser-platform-daily-scheduler.js';

describe('browser platform daily scheduler', () => {
  it('uses Flash only for the bounded Douyin daily draft', () => {
    const config = {
      draftModelKey: 'deepseek-v4-flash',
      rewriteModelKey: 'deepseek-v4-pro',
    };

    expect(browserPlatformGenerationModelKey('douyin', config)).toBe('deepseek-v4-flash');
    expect(browserPlatformGenerationModelKey('sohu', config)).toBe('deepseek-v4-pro');
    expect(browserPlatformGenerationModelKey('lieju', config)).toBe('deepseek-v4-pro');
  });

  it('reports partial scheduling and only sends the remaining quota to attention', () => {
    expect(candidateLimitAttentionMessage({ candidateLimit: 15, targetCount: 10 }, 7)).toBe(
      '当天已尝试 15 篇；已有 7 篇完成排期（含发布中或已发布），仍缺 3 篇，批次已转为需要处理。',
    );
  });

  it('rotates Douyin candidates across distinct search-decision intents instead of resetting daily', () => {
    const angles = Array.from({ length: 12 }, (_, index) =>
      douyinDailyDecisionAngle({
        businessDate: '2026-08-30',
        candidateNo: index + 1,
        keyword: '广州搬家公司',
        targetCount: 3,
      }),
    );

    expect(angles.slice(0, 3).map((angle) => angle.key)).toEqual([
      'recommendation',
      'comparison',
      'pricing',
    ]);
    expect(new Set(angles.map((angle) => angle.key)).size).toBe(12);
    expect(
      douyinDailyDecisionAngle({
        businessDate: '2026-08-31',
        candidateNo: 1,
        keyword: '广州搬家公司',
        targetCount: 3,
      }).key,
    ).toBe('legitimacy');
  });

  it('keeps the decision question when a long Douyin keyword must be shortened', () => {
    const angle = douyinDailyDecisionAngle({
      businessDate: '2026-08-30',
      candidateNo: 3,
      keyword: '广州黄埔高层小区家庭搬迁起重吊装仓储运输服务选择',
      targetCount: 3,
    });

    expect(angle.title).toMatch(/收费怎么核对$/u);
    expect([...angle.title].length).toBeLessThanOrEqual(26);
    expect(angle.title).not.toContain('仓储运输服务选择');
  });
});
