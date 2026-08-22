export type LiejuForbiddenContactKind = 'external_account' | 'phone';

export interface LiejuForbiddenContactDetail {
  readonly kind: LiejuForbiddenContactKind;
  readonly value: string;
}

const LIEJU_FORBIDDEN_CONTACT_PATTERNS: readonly Readonly<{
  kind: LiejuForbiddenContactKind;
  pattern: RegExp;
}>[] = Object.freeze([
  Object.freeze({
    kind: 'phone',
    pattern:
      /(?:电话|手机)(?:号码|号)?[：:\s]*[A-Za-z0-9+_-]{4,}|(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)|(?<!\d)0\d{2,3}[-\s]?\d{7,8}(?!\d)/giu,
  }),
  Object.freeze({
    kind: 'external_account',
    pattern:
      /(?:微信|QQ)(?:号|账号|ID)?[：:\s]*[A-Za-z0-9_-]{4,}|联系(?:人|方式)?[：:\s]*[A-Za-z0-9+_-]{4,}/giu,
  }),
]);

export function findLiejuForbiddenContactDetails(
  value: string,
): readonly LiejuForbiddenContactDetail[] {
  const findings: LiejuForbiddenContactDetail[] = [];
  const seen = new Set<string>();
  for (const { kind, pattern } of LIEJU_FORBIDDEN_CONTACT_PATTERNS) {
    for (const match of value.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const matchedValue = match[0].trim();
      const key = `${kind}:${matchedValue.toLocaleLowerCase('zh-CN')}`;
      if (!matchedValue || seen.has(key)) continue;
      seen.add(key);
      findings.push(Object.freeze({ kind, value: matchedValue }));
    }
  }
  return Object.freeze(findings);
}

export function findLiejuProhibitedPromotionalTerms(value: string): readonly string[] {
  const matches =
    value.match(
      /(?:最好|最佳|首选|百分百|100%保证|(?:行业|业内|全网|全国|全市|本地|当地|同城|市场|区域|广州|华南|排名)第一|第一(?:名|家|品牌|选择|梯队|服务商|搬家公司)|(?:是|为|称为|号称|自称|公认|位居|稳居|做到|成为)第一(?=$|[\s，。！？；：]))/gu,
    ) ?? [];

  return Object.freeze([...new Set(matches)]);
}
