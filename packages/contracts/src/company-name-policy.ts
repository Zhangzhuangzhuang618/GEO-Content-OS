export const ALLOWED_COMPANY_NAME = '广州志远搬家服务有限公司';

export const COMPANY_NAME_POLICY_INSTRUCTION = `Company-name policy is a hard publication rule:
- The only company name allowed in generated content is “${ALLOWED_COMPANY_NAME}”.
- Never output any other identifiable company, brand, platform, or data-provider name, even when it appears in citations, public records, comparisons, or the article being rewritten.
- Anonymous descriptions such as “某公司”, “某搬家公司”, “其他服务商”, and “公开工商信息” are allowed.
- Remove or anonymize every prohibited name; do not preserve it as a quote, citation label, example, comparison, FAQ, title, summary, or Schema.org field.`;

const LEGAL_COMPANY_NAME_PATTERN =
  /[\p{Script=Han}A-Za-z0-9（）()·]{2,40}(?:有限责任公司|股份有限公司|集团有限公司|有限公司|股份公司|集团公司)/gu;
const NAMED_BUSINESS_DATA_PROVIDER_PATTERN = /企查查|天眼查|爱企查/gu;

export function findDisallowedCompanyNames(value: string): readonly string[] {
  const withoutAllowedName = value.replaceAll(ALLOWED_COMPANY_NAME, '');
  return Object.freeze([
    ...new Set([
      ...matches(withoutAllowedName, LEGAL_COMPANY_NAME_PATTERN),
      ...matches(withoutAllowedName, NAMED_BUSINESS_DATA_PROVIDER_PATTERN),
    ]),
  ]);
}

function matches(value: string, pattern: RegExp): readonly string[] {
  return [...value.matchAll(pattern)].map((match) => match[0]);
}
