import { describe, expect, it } from 'vitest';

import {
  companyNamePolicyInstruction,
  findDisallowedCompanyNames,
  findPublishedOwnerCompanyNames,
} from './company-name-policy.js';

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

  it('derives each tenant owner from first-party positioning and CTA only', () => {
    const names = findPublishedOwnerCompanyNames({
      banned: ['不得提及广州竞品搬家有限公司'],
      cta: '联系广州众人搬家起重吊装有限公司确认需求。',
      differentiators: ['优于广州另一家搬家有限公司'],
      positioning: '广东众人搬家起重吊装有限公司提供搬迁服务。',
    });

    expect(names).toEqual(['广东众人搬家起重吊装有限公司', '广州众人搬家起重吊装有限公司']);
    expect(
      findDisallowedCompanyNames('广东众人搬家起重吊装有限公司与广州竞品搬家有限公司。', names),
    ).toEqual(['广州竞品搬家有限公司']);
  });

  it('does not fall back to another tenant when no owner name is published', () => {
    const names = findPublishedOwnerCompanyNames({
      cta: '通过页面联系方式咨询。',
      positioning: '广州本地搬家服务企业',
    });

    expect(names).toEqual([]);
    expect(findDisallowedCompanyNames('广州志远搬家服务有限公司', names)).toEqual([
      '广州志远搬家服务有限公司',
    ]);
    expect(companyNamePolicyInstruction(names)).toContain(
      'No identifiable owner company name is declared',
    );
  });

  it('removes one CTA action without truncating a legal name that starts with an action word', () => {
    expect(
      findPublishedOwnerCompanyNames({
        cta: '联系选择科技有限公司确认需求。',
        positioning: '咨询服务有限公司提供企业咨询。',
      }),
    ).toEqual(['咨询服务有限公司', '选择科技有限公司']);
  });
});
