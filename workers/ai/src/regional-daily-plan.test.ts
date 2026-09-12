import { describe, expect, it } from 'vitest';
import { regionalInstructions, regionalKeyword } from './regional-daily-plan.js';

describe('regional daily topics', () => {
  it.each([
    ['广州搬家多少钱', '增城搬家多少钱'],
    ['广州市天河区办公室搬迁', '增城办公室搬迁'],
    ['搬家多少钱', '增城搬家多少钱'],
  ])('derives %s without changing the stored keyword', (term, expected) => {
    expect(regionalKeyword(term, '增城')).toBe(expected);
  });
  it('does not inject instructions when disabled', () => {
    expect(regionalInstructions(null)).toBe('');
  });
  it('limits Japanese service clarification to Japanese topics', () => {
    const region = { slot: 1, district: '增城' };
    expect(regionalInstructions(region, '增城仓库搬迁')).not.toContain('半日式');
    expect(regionalInstructions(region, '增城半日式搬迁')).toContain('不是半日或半天完成');
  });
  it('keeps legal names and source addresses outside the transformation', () => {
    expect(regionalInstructions({ slot: 1, district: '增城' })).toContain(
      '企业全称、证照及真实地址原样保留',
    );
  });
});
