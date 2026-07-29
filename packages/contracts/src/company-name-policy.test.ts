import { describe, expect, it } from 'vitest';

import { findDisallowedCompanyNames } from './company-name-policy.js';

describe('company name publication policy', () => {
  it('allows the owner company and anonymous company descriptions', () => {
    expect(
      findDisallowedCompanyNames(
        '广州志远搬家服务有限公司可以说明自身服务；某公司、某搬家公司和其他服务商必须保持匿名。',
      ),
    ).toEqual([]);
  });

  it('finds legal company names and named business-data providers', () => {
    expect(
      findDisallowedCompanyNames('广州家盛搬家有限公司、广州四通搬家有限公司的信息来源于企查查。'),
    ).toEqual(['广州家盛搬家有限公司', '广州四通搬家有限公司', '企查查']);
  });
});
