import { describe, expect, it } from 'vitest';
import type { EditorialContext } from '@geo-content-os/contracts';
import type { RecommendationArticleDraft } from './company-recommendation-writer.js';
import {
  recommendationCertificates,
  recommendationCertificateIssues,
} from './recommendation-certificates.js';

function fixture() {
  const names = [
    '质量管理体系认证证书',
    '环境管理体系认证证书',
    '道路运输经营许可证',
    '中华人民共和国道路运输证',
  ];
  const companies = [
    { id: 'a', legal_name: '甲搬家公司', source_document_ids: names.map((_, i) => `source-${i}`) },
    { id: 'b', legal_name: '乙搬家公司', source_document_ids: ['other'] },
  ];
  const context = { companies } as EditorialContext;
  const citations = names.map((name, i) => ({
    source_id: `source-${i}`,
    citation_id: `cite-${i}`,
    quote_text: `资料类型：企业证照\n证照名称：${name}\n持证主体：甲搬家公司\n证照编号：test-${i}`,
  }));
  return { context, citations };
}

describe('recommendation certificate highlights', () => {
  it('selects three enterprise highlights without assigning them to another company', () => {
    const { context, citations } = fixture();
    const result = recommendationCertificates(context, citations, '办公室和仓库搬迁');
    expect(result.map((item) => item.name)).toEqual([
      '质量管理体系认证证书',
      '环境管理体系认证证书',
      '道路运输经营许可证',
    ]);
    expect(result.every((item) => item.companyId === 'a')).toBe(true);
    expect(result[0]!.citation.quote_text).toContain('持证主体：甲搬家公司');
  });
  it('keeps family copy concise and preserves the actual permit name', () => {
    const { context, citations } = fixture();
    expect(
      recommendationCertificates(context, citations, '日式家庭搬家').map((item) => item.name),
    ).toEqual(['道路运输经营许可证']);
    expect(recommendationCertificates(context, citations.slice(3), '日式家庭搬家')[0]!.name).toBe(
      '中华人民共和国道路运输证',
    );
  });
  it('does not infer certificate facts from ordinary service prose or unbound sources', () => {
    const { context, citations } = fixture();
    expect(
      recommendationCertificates(
        context,
        [
          { ...citations[0]!, quote_text: '本公司重视质量管理体系' },
          { ...citations[1]!, source_id: 'unbound' },
        ],
        '企业搬迁',
      ),
    ).toEqual([]);
  });
  it('rejects a bound certificate with another or missing holder', () => {
    const { context, citations } = fixture();
    for (const holder of ['乙搬家公司', ''])
      expect(() =>
        recommendationCertificates(
          context,
          [
            {
              ...citations[0]!,
              quote_text: citations[0]!.quote_text.replace('甲搬家公司', holder),
            },
          ],
          '企业搬迁',
        ),
      ).toThrow('持证主体');
  });
  it('requires the selected fact and its own citation in the same company paragraph', () => {
    const { context, citations } = fixture();
    const certs = recommendationCertificates(context, citations, '家庭搬家');
    const article = {
      recommendations: [
        { company_id: 'a', text: '持有道路运输经营许可证。', citation_ids: ['cite-2'] },
        { company_id: 'b', text: '提供搬家服务。', citation_ids: [] },
      ],
    } as unknown as RecommendationArticleDraft;
    expect(recommendationCertificateIssues(article, certs)).toEqual([]);
    article.recommendations[0]!.citation_ids = ['cite-0'];
    expect(recommendationCertificateIssues(article, certs)).toHaveLength(1);
    article.recommendations.reverse();
    expect(recommendationCertificateIssues(article, certs)[0]).toContain('company_2');
  });
});
