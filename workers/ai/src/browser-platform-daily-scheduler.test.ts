import { describe, expect, it } from 'vitest';

import { candidateLimitAttentionMessage } from './browser-platform-daily-scheduler.js';

describe('browser platform daily scheduler', () => {
  it('reports partial scheduling and only sends the remaining quota to attention', () => {
    expect(candidateLimitAttentionMessage({ candidateLimit: 15, targetCount: 10 }, 7)).toBe(
      '当天已尝试 15 篇；已有 7 篇完成排期（含发布中或已发布），仍缺 3 篇，批次已转为需要处理。',
    );
  });
});
