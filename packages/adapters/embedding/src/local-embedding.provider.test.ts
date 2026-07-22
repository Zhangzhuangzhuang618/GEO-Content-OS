import { describe, expect, it } from 'vitest';

import { featureVector } from './local-embedding.provider.js';

describe('local feature-hash embeddings', () => {
  it('ranks Chinese text sharing topic terms above unrelated text', () => {
    const query = featureVector('广州搬家公司怎么选');
    const related = featureVector('选择广州搬家公司时应核对车辆、员工和收费范围');
    const unrelated = featureVector('企业软件如何进行数据库备份');
    expect(cosine(query, related)).toBeGreaterThan(cosine(query, unrelated));
    expect(query).toHaveLength(1_536);
  });
});

function cosine(left: readonly number[], right: readonly number[]) {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}
