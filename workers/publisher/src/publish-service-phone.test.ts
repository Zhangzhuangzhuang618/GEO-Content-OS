import { describe, expect, it } from 'vitest';
import { hasExactOfficialSiteServicePhone } from '@geo-content-os/contracts';
import { resolvePublishServicePhone } from './publish-service-phone.js';

const account = 'e4ff285d-7df4-4fec-883c-322a1648006a';
const phones = ['02085627757', '4008372383'];
const compatibility = { [account]: phones };
const content = (phone: string) => ({ blocks: [], cta: `请致电 ${phone}。` });

describe('publication-only service phone compatibility', () => {
  it.each(phones)('accepts the approved account phone %s without changing content', (phone) => {
    const article = content(phone);
    const snapshot = JSON.stringify(article);
    const selected = resolvePublishServicePhone(article, phones[1]!, account, compatibility);
    expect(selected).toBe(phone);
    expect(hasExactOfficialSiteServicePhone(article, selected)).toBe(true);
    expect(JSON.stringify(article)).toBe(snapshot);
  });
  it('does not authorize the old phone for another account', () => {
    const selected = resolvePublishServicePhone(
      content(phones[0]!),
      phones[1]!,
      'another-account',
      compatibility,
    );
    expect(hasExactOfficialSiteServicePhone(content(phones[0]!), selected)).toBe(false);
  });
  it('does not authorize arbitrary old phones or bypass a future primary-phone change', () => {
    const unrelated = '4001234567';
    expect(resolvePublishServicePhone(content(unrelated), phones[1]!, account, compatibility)).toBe(
      phones[1],
    );
    expect(resolvePublishServicePhone(content(phones[0]!), unrelated, account, compatibility)).toBe(
      unrelated,
    );
    expect(
      resolvePublishServicePhone(content(phones[0]!), null, account, compatibility),
    ).toBeNull();
  });
  it('retains the exactly-once and CTA placement gates', () => {
    for (const article of [
      { blocks: [], cta: `联系 ${phones[0]} 或 ${phones[1]}` },
      { blocks: [{ text: phones[0] }], cta: '欢迎咨询' },
      { blocks: [{ text: phones[0] }], cta: phones[0] },
    ]) {
      expect(
        hasExactOfficialSiteServicePhone(
          article,
          resolvePublishServicePhone(article, phones[1]!, account, compatibility),
        ),
      ).toBe(false);
    }
  });
});
