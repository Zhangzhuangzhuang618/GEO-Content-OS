import { describe, expect, it } from 'vitest';

import { supportsDouyinPriceComparison } from './douyin-price-evidence.js';

describe('Douyin price comparison evidence', () => {
  it.each([
    '300平米以下办公室基础搬迁费用低至4800元，签约即赠价值500元的办公设备保洁服务。',
    '收费对比：基础搬迁4800元，签约即赠价值500元保洁服务。',
    '报价4800元，使用500元优惠券。',
    '费用对比：套餐4800元，立减500元。',
    '费用对比需逐项确认。某套餐4800元，另一个套餐6000元。',
    '搬家费用为4800–6000元。',
    '比较方案后再询价，没有公布具体价格。',
  ])('does not promise a comparison from unrelated or promotional amounts: %s', (quote) => {
    expect(supportsDouyinPriceComparison(quote)).toBe(false);
  });

  it.each([
    '同一清单的费用对比：仅运输4800元，含打包6000元。',
    '比较报价：方案A为4800元，方案B为6000元，签约赠价值500元保洁。',
  ])('accepts explicit comparison with two charge amounts: %s', (quote) => {
    expect(supportsDouyinPriceComparison(quote)).toBe(true);
  });
});
