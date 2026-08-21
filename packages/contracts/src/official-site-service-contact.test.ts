import { describe, expect, it } from 'vitest';

import {
  applyOfficialSiteServicePhone,
  hasExactOfficialSiteServicePhone,
  OfficialSiteServicePhoneSchema,
  officialSiteServiceCta,
} from './official-site-service-contact.js';

describe('official-site service contact', () => {
  it('accepts supported mainland China service phone formats', () => {
    expect(OfficialSiteServicePhoneSchema.safeParse('02085627757').success).toBe(true);
    expect(OfficialSiteServicePhoneSchema.safeParse('13800138000').success).toBe(true);
    expect(OfficialSiteServicePhoneSchema.safeParse('4001234567').success).toBe(true);
    expect(OfficialSiteServicePhoneSchema.safeParse('020-85627757').success).toBe(false);
  });

  it('merges the authoritative phone into one top-level CTA', () => {
    const content = {
      blocks: [
        { block_key: 'body', block_type: 'paragraph', text: '正文' },
        { block_key: 'legacy-cta', block_type: 'cta', text: '欢迎咨询' },
      ],
      citation_map: [
        { citation_ids: ['citation'], claim_key: 'legacy-cta', claim_text: '欢迎咨询' },
      ],
      cta: null,
      platform_code: 'official_site',
    } as const;

    const normalized = applyOfficialSiteServicePhone(content, '02085627757');

    expect(normalized.blocks).toEqual([
      { block_key: 'body', block_type: 'paragraph', text: '正文' },
    ]);
    expect(normalized.citation_map).toEqual([]);
    expect(normalized.cta).toBe('欢迎咨询；联系电话：02085627757。');
  });

  it('does not duplicate a phone already present in the CTA', () => {
    expect(officialSiteServiceCta('如需咨询请致电 02085627757。', '02085627757')).toBe(
      '如需咨询请致电 02085627757。',
    );
  });

  it('keeps one authoritative phone when a CTA is duplicated or truncated', () => {
    const duplicated = officialSiteServiceCta(
      '咨询 02085627757，或再拨打 02085627757。',
      '02085627757',
    );
    const long = officialSiteServiceCta(`咨询说明${'详'.repeat(220)}02085627757`, '02085627757');

    expect(duplicated.split('02085627757')).toHaveLength(2);
    expect(long.split('02085627757')).toHaveLength(2);
    expect([...long]).toHaveLength(200);
  });

  it('replaces stale CTA phone numbers and rejects any extra phone in content', () => {
    const cta = officialSiteServiceCta('请拨打 4007654321 咨询。', '02085627757');

    expect(cta).toBe('请拨打 02085627757 咨询。');
    expect(
      hasExactOfficialSiteServicePhone(
        { blocks: [{ text: '正文含另一个电话 4007654321。' }], cta },
        '02085627757',
      ),
    ).toBe(false);
    expect(hasExactOfficialSiteServicePhone({ blocks: [], cta }, '02085627757')).toBe(true);
  });

  it('does not change non-official-site content', () => {
    const content = {
      blocks: [{ block_key: 'body', block_type: 'paragraph', text: '正文' }],
      cta: null,
      platform_code: 'baijiahao',
    } as const;
    expect(applyOfficialSiteServicePhone(content, '02085627757')).toBe(content);
  });
});
