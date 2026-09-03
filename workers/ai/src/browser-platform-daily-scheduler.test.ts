import { describe, expect, it } from 'vitest';

import {
  browserPlatformGenerationModelKey,
  candidateLimitAttentionMessage,
  douyinContentVoiceInstruction,
  douyinDailyDecisionAngle,
  douyinEvidenceTitleOpportunity,
  douyinTitleSubject,
  isDouyinContentVoice,
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

  it('keeps account content voice separate and recognizes only supported values', () => {
    expect(isDouyinContentVoice('enterprise_official')).toBe(true);
    expect(isDouyinContentVoice('frontline_mover')).toBe(true);
    expect(isDouyinContentVoice('customer_perspective')).toBe(true);
    expect(isDouyinContentVoice('面向企业客户')).toBe(false);
    expect(douyinContentVoiceInstruction('enterprise_official')).toContain('企业官方');
    expect(douyinContentVoiceInstruction('frontline_mover')).toContain('约十年现场判断积累');
    expect(douyinContentVoiceInstruction('frontline_mover')).toContain('十年只是说话成熟度标尺');
    expect(douyinContentVoiceInstruction('frontline_mover')).toContain('我到现场一般先看');
    expect(douyinContentVoiceInstruction('frontline_mover')).toContain(
      '我就职于{{当前企业法定全称}}，欢迎联系我核对方案',
    );
    expect(douyinContentVoiceInstruction('frontline_mover')).toContain('官网公开案例');
    expect(douyinContentVoiceInstruction('frontline_mover')).toContain('不得切换');
    expect(douyinContentVoiceInstruction('customer_perspective')).toContain('不得冒充已成交客户');
    expect(douyinContentVoiceInstruction('customer_perspective')).toContain('不得出现“从客户视角”');
    expect(douyinContentVoiceInstruction('customer_perspective')).toContain('第三方真实经历');
    expect(douyinContentVoiceInstruction('customer_perspective')).toContain('我最担心');
    expect(douyinContentVoiceInstruction('customer_perspective')).toContain('放进备选名单');
    expect(douyinContentVoiceInstruction('customer_perspective')).toContain('核心是');
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

  it('binds the project region and keyword scene instead of leaving a generic title subject', () => {
    expect(
      douyinTitleSubject({
        fallbackRegion: '广州',
        keyword: '靠谱的搬家公司',
        region: '通用/无地域',
        scene: '居民搬家',
      }),
    ).toBe('广州居民搬家');
  });

  it('binds a title evidence promise only when retrieved evidence matches the selected intent', () => {
    const promise = douyinEvidenceTitleOpportunity('legitimacy', [
      {
        chunkId: 'chunk-1',
        quoteText: '资料类型：企业证照\n证照名称：道路运输经营许可证',
        sourceId: 'source-1',
      },
    ]);
    const angle = douyinDailyDecisionAngle({
      businessDate: '2026-08-31',
      candidateNo: 1,
      evidencePromise: promise,
      keyword: '跨城搬家',
      targetCount: 3,
      titleSubject: '广州异地搬家',
    });

    expect(promise).toBe('资质核验');
    expect(angle).toMatchObject({
      evidencePromise: '资质核验',
      key: 'legitimacy',
      title: '广州异地搬家资质核验清单',
      titleSubject: '广州异地搬家',
    });
    expect([...angle.title].length).toBeLessThanOrEqual(26);
  });
});
