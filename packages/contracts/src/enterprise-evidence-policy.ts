import { findPublishedOwnerCompanyNames } from './company-name-policy.js';

export const ENTERPRISE_EVIDENCE_KINDS = Object.freeze([
  'business_license',
  'industry_permit',
  'transport_certificate',
  'quality_management',
  'environment_management',
  'occupational_health_safety',
  'insurance_or_damage_protection',
] as const);

export type EnterpriseEvidenceKind = (typeof ENTERPRISE_EVIDENCE_KINDS)[number];

export interface EnterpriseEvidenceReference {
  readonly citationId: string;
  readonly displayName: string;
  readonly kind: EnterpriseEvidenceKind;
  readonly sourceId: string;
}

const INTERNAL_CUSTOMER_COPY_PATTERNS = Object.freeze([
  /(?:仅|只)反映企业基本状况[^。！？!?\n]*(?:不代表|不能代表)服务质量/gu,
  /企业第一方口径/gu,
  /需(?:要)?自行核实/gu,
  /不代表服务质量/gu,
  /不代表理赔结果(?:或到期后的持续有效性)?/gu,
  /不代表[^。！？!?\n]{0,24}持续有效性/gu,
  /证据边界/gu,
  /证据分类/gu,
  /引用资料不足/gu,
  /资料\s*(?:ID|编号)/giu,
  /模型免责/gu,
  /\bcitation_map\b/giu,
  /(?:内部|系统)(?:风控|规则|证据)(?:名称|分类|标签|术语)?/gu,
]);

const CUSTOMER_COPY_SENTENCE_PATTERN = /[^。！？!?\n]*(?:。|！|？|!|\?|\n|$)/gu;

export function uniquePublishedOwnerCompanyName(profile: unknown): string | null {
  const names = findPublishedOwnerCompanyNames(profile);
  return names.length === 1 ? names[0]! : null;
}

export function enterpriseEvidenceCustomerRequestSupported(settings: unknown): boolean {
  return (
    record(settings) &&
    settings['schema_version'] === 'workspace-settings@1' &&
    settings['enterprise_evidence_customer_request_supported'] === true
  );
}

export function enterpriseEvidenceRequiredKinds(
  settings: unknown,
): readonly EnterpriseEvidenceKind[] {
  if (!record(settings) || settings['schema_version'] !== 'workspace-settings@1') return [];
  const values = settings['enterprise_evidence_required_kinds'];
  if (!Array.isArray(values)) return [];
  return Object.freeze([
    ...new Set(values.filter((value): value is EnterpriseEvidenceKind => isEvidenceKind(value))),
  ]);
}

export function missingEnterpriseEvidenceKinds(
  requiredKinds: readonly EnterpriseEvidenceKind[],
  references: readonly Pick<EnterpriseEvidenceReference, 'kind'>[],
): readonly EnterpriseEvidenceKind[] {
  const available = new Set(references.map((reference) => reference.kind));
  return Object.freeze(requiredKinds.filter((kind) => !available.has(kind)));
}

export function classifyEnterpriseEvidence(
  metadata: unknown,
): { readonly displayName: string; readonly kind: EnterpriseEvidenceKind } | null {
  if (!record(metadata)) return null;
  if (metadata['schema_version'] === 'source-insurance-proof@1') {
    const name = normalizedText(metadata['insurance_type']);
    return name
      ? Object.freeze({ displayName: name, kind: 'insurance_or_damage_protection' })
      : null;
  }
  if (metadata['schema_version'] !== 'source-certificate@1') return null;
  const name = normalizedText(metadata['certificate_name']);
  if (!name) return null;
  const kind = certificateKind(name);
  return kind ? Object.freeze({ displayName: name, kind }) : null;
}

export function buildEnterpriseAssuranceText(input: {
  readonly companyName: string;
  readonly customerRequestSupported: boolean;
  readonly evidenceNames: readonly string[];
  readonly serviceType: string;
}): string {
  const companyName = requiredText(input.companyName, 'companyName');
  const serviceType = requiredText(input.serviceType, 'serviceType');
  const evidenceNames = [
    ...new Set(input.evidenceNames.map((name) => name.trim()).filter(Boolean)),
  ];
  if (evidenceNames.length === 0) throw new TypeError('evidenceNames must not be empty');
  const verification = input.customerRequestSupported
    ? `${companyName}已提供上述有效资料，客户可通过页面联系方式索取核验。`
    : `${companyName}已提供上述有效资料，可供客户核验。`;
  return `依法登记的企业通常可以通过公开工商信息平台查询成立时间、注册资本和登记地址。选择${serviceType}服务商时，还可以核对${joinChinese(evidenceNames)}。${verification}`;
}

export function findInternalCustomerCopyLanguage(value: string): readonly string[] {
  return Object.freeze([
    ...new Set(
      INTERNAL_CUSTOMER_COPY_PATTERNS.flatMap((pattern) =>
        [...value.matchAll(pattern)].map((match) => match[0].trim()).filter(Boolean),
      ),
    ),
  ]);
}

export function sanitizeCustomerFacingText(value: string): string {
  if (findInternalCustomerCopyLanguage(value).length === 0) return value.trim();
  return value
    .match(CUSTOMER_COPY_SENTENCE_PATTERN)!
    .filter((sentence) => findInternalCustomerCopyLanguage(sentence).length === 0)
    .join('')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

export function sanitizeEvidenceQuoteForCustomerCopy(value: string): string {
  return value
    .split(/\r?\n/gu)
    .filter((line) => !/^\s*(?:用途边界|证据边界|内部(?:风控|规则|证据))\s*[：:]/u.test(line))
    .map((line) => sanitizeCustomerFacingText(line))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function certificateKind(name: string): EnterpriseEvidenceKind | null {
  if (/营业执照/u.test(name)) return 'business_license';
  if (/道路运输经营许可证|行业经营许可证/u.test(name)) return 'industry_permit';
  if (/道路运输证|运输经营证件/u.test(name)) return 'transport_certificate';
  if (/质量管理体系/u.test(name)) return 'quality_management';
  if (/环境管理体系/u.test(name)) return 'environment_management';
  if (/职业健康安全管理体系/u.test(name)) return 'occupational_health_safety';
  if (/保险|损坏保障|损失保障|赔付保障/u.test(name)) return 'insurance_or_damage_protection';
  return null;
}

function isEvidenceKind(value: unknown): value is EnterpriseEvidenceKind {
  return ENTERPRISE_EVIDENCE_KINDS.some((kind) => kind === value);
}

function joinChinese(values: readonly string[]): string {
  if (values.length === 1) return values[0]!;
  return `${values.slice(0, -1).join('、')}和${values.at(-1)}`;
}

function normalizedText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must not be empty`);
  return normalized;
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
