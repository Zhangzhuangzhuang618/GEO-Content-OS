const LEGAL_COMPANY_NAME_PATTERN =
  /[\p{Script=Han}A-Za-z0-9（）()·]{2,40}(?:有限责任公司|股份有限公司|集团有限公司|有限公司|股份公司|集团公司)/gu;
const COMPLETE_LEGAL_COMPANY_NAME_PATTERN =
  /^[\p{Script=Han}A-Za-z0-9（）()·]{2,40}(?:有限责任公司|股份有限公司|集团有限公司|有限公司|股份公司|集团公司)$/u;
const NAMED_BUSINESS_DATA_PROVIDER_PATTERN = /企查查|天眼查|爱企查/gu;

export function findPublishedOwnerCompanyNames(profile: unknown): readonly string[] {
  if (!record(profile)) return Object.freeze([]);
  const positioning = typeof profile['positioning'] === 'string' ? profile['positioning'] : '';
  const cta = typeof profile['cta'] === 'string' ? profile['cta'] : '';
  return Object.freeze([
    ...new Set(
      [
        ...matches(positioning, LEGAL_COMPANY_NAME_PATTERN).map(normalizeDetectedCompanyName),
        ...matches(cta, LEGAL_COMPANY_NAME_PATTERN).map(normalizePublishedCompanyName),
      ].filter((name) => COMPLETE_LEGAL_COMPANY_NAME_PATTERN.test(name)),
    ),
  ]);
}

export function companyNamePolicyInstruction(allowedCompanyNames: readonly string[]): string {
  const allowed = normalizeAllowedCompanyNames(allowedCompanyNames);
  const ownerRule =
    allowed.length > 0
      ? `The only identifiable owner company names allowed in generated content are ${allowed
          .map((name) => `“${name}”`)
          .join(', ')}.`
      : 'No identifiable owner company name is declared in the published brand profile. Do not output any identifiable company name.';
  return `Company-name policy is a hard publication rule:
- ${ownerRule}
- Never output any other identifiable company, brand, platform, or data-provider name, even when it appears in citations, public records, comparisons, or the article being rewritten.
- Anonymous descriptions such as “某公司”, “某搬家公司”, “其他服务商”, and “公开工商信息” are allowed.
- Remove or anonymize every prohibited name; do not preserve it as a quote, citation label, example, comparison, FAQ, title, summary, or Schema.org field.`;
}

export function findDisallowedCompanyNames(
  value: string,
  allowedCompanyNames: readonly string[] = [],
): readonly string[] {
  const withoutAllowedName = normalizeAllowedCompanyNames(allowedCompanyNames)
    .sort((left, right) => right.length - left.length)
    .reduce((current, name) => current.replaceAll(name, ''), value);
  return Object.freeze([
    ...new Set(
      [
        ...matches(withoutAllowedName, LEGAL_COMPANY_NAME_PATTERN),
        ...matches(withoutAllowedName, NAMED_BUSINESS_DATA_PROVIDER_PATTERN),
      ].map(normalizeDetectedCompanyName),
    ),
  ]);
}

function normalizeAllowedCompanyNames(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizePublishedCompanyName(value: string): string {
  return normalizeDetectedCompanyName(value).replace(
    /^(?:请|可|欢迎|立即|直接|建议|如需|可以)?(?:联系|咨询|选择|委托)/u,
    '',
  );
}

function normalizeDetectedCompanyName(value: string): string {
  return value.replace(/^(?:与|及|或)(?=[\p{Script=Han}A-Za-z0-9（）()·]{2,})/u, '');
}

function matches(value: string, pattern: RegExp): readonly string[] {
  return [...value.matchAll(pattern)].map((match) => match[0]);
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
