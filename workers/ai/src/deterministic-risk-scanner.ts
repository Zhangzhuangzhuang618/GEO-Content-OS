import type { PlatformCode } from '@geo-content-os/contracts';
import type { QualityCheckerData, QualityIssue } from '@geo-content-os/contracts/skills';

export interface DeterministicRiskCitation {
  readonly claimText: string;
  readonly id: string;
}

export interface DeterministicRiskScanInput {
  readonly brandProfile: Readonly<Record<string, unknown>>;
  readonly citations: readonly DeterministicRiskCitation[];
  readonly content: Readonly<Record<string, unknown>>;
  readonly platformCode: PlatformCode;
}

interface LocatedText {
  readonly location: string;
  readonly text: string;
}

interface RiskRule {
  readonly category: QualityIssue['category'];
  readonly message: string;
  readonly pattern: RegExp;
  readonly ruleId: string;
  readonly suggestion: string;
  readonly support: 'brand_or_citation' | 'citation' | 'never';
}

const TITLE_LIMITS: Readonly<Record<PlatformCode, number>> = Object.freeze({
  baijiahao: 40,
  douyin: 80,
  official_site: 60,
  toutiao: 50,
  wechat_mp: 64,
  xiaohongshu: 20,
  zhihu: 80,
});

const RISK_RULES: readonly RiskRule[] = Object.freeze([
  {
    category: 'security',
    message: '内容疑似包含提示注入或可执行脚本。',
    pattern: /忽略(?:以上|此前|前面).{0,12}(?:指令|规则)|(?:system|developer)\s+prompt|<script\b/iu,
    ruleId: 'deterministic.security.prompt_injection',
    suggestion: '删除提示指令和脚本内容后重新生成。',
    support: 'never',
  },
  {
    category: 'security',
    message: '内容疑似泄露访问令牌、密码或私钥。',
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._-]{20,}|\bsk-[A-Za-z0-9_-]{20,}|\b(?:password|passwd|api[_ -]?key)\s*[:=]\s*\S{8,}/iu,
    ruleId: 'deterministic.security.secret_leakage',
    suggestion: '立即删除凭证；如凭证真实存在，还应在对应系统中轮换。',
    support: 'never',
  },
  {
    category: 'compliance',
    message: '内容包含绝对化排名、效果保证或无法安全承诺的表述。',
    pattern:
      /(?:全网|全国|行业|本地|广州).{0,8}(?:第[一1]|榜首|最(?:佳|优|强)|首选)|(?:百分之百|100%)|(?:保证|确保|承诺|绝对).{0,12}(?:成功|有效|满意|最低|最高|不会|无风险|零风险)/u,
    ruleId: 'deterministic.compliance.absolute_claim',
    suggestion: '改为可核验的客观描述，不使用排名或结果保证。',
    support: 'never',
  },
  {
    category: 'fact',
    message: '内容包含未在企业档案或证据中核验的价格、报价或收费数字。',
    pattern: /(?:¥|￥)\s*\d|\d+(?:\.\d+)?\s*元|(?:价格|报价|收费|费用).{0,16}\d/u,
    ruleId: 'deterministic.fact.unsupported_price',
    suggestion: '删除具体价格，或先把有效价格依据加入企业档案或知识证据。',
    support: 'brand_or_citation',
  },
  {
    category: 'fact',
    message: '内容包含未在企业档案或证据中核验的联系电话。',
    pattern: /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)|(?<!\d)0\d{2,3}[-\s]?\d{7,8}(?!\d)/u,
    ruleId: 'deterministic.fact.unsupported_phone',
    suggestion: '删除电话号码，或先在已发布企业档案中确认该号码。',
    support: 'brand_or_citation',
  },
  {
    category: 'fact',
    message: '内容包含未在企业档案或证据中核验的详细地址。',
    pattern: /(?:地址|位于|坐落于)[：:\s]*[^。；;\n]{3,40}(?:路|街|大道|巷|号|大厦|园区)/u,
    ruleId: 'deterministic.fact.unsupported_address',
    suggestion: '删除详细地址，或先在已发布企业档案中确认。',
    support: 'brand_or_citation',
  },
  {
    category: 'fact',
    message: '内容包含未在企业档案或证据中核验的企业规模或经营数量。',
    pattern:
      /(?:自有|拥有|配备|现有|累计|服务|员工|师傅|车辆|车队|客户).{0,24}(?:\d+(?:\.\d+)?(?:\+|余|多|以上)?|数十|近百|上百|数百)\s*(?:台|辆|人|名|家|个|单|次|年)/u,
    ruleId: 'deterministic.fact.unsupported_scale',
    suggestion: '删除数量，或使表述与已发布企业档案、知识证据精确一致。',
    support: 'brand_or_citation',
  },
  {
    category: 'fact',
    message: '内容包含需要外部证据支持的资质、认证、荣誉或许可声明。',
    pattern:
      /(?:获得|持有|拥有|通过|取得|获评|荣获).{0,24}(?:资质|认证|许可证|许可|荣誉|奖项|称号|AAA)|(?:国家级|省级|市级).{0,16}(?:资质|认证|荣誉|奖项|称号)/u,
    ruleId: 'deterministic.fact.external_credential_requires_evidence',
    suggestion: '删除该声明，或关联能直接支持它的权威外部证据。',
    support: 'citation',
  },
]);

export function scanDeterministicRisks(input: DeterministicRiskScanInput): readonly QualityIssue[] {
  const issues: QualityIssue[] = [];
  const brandEvidence = canonicalize(flattenStrings(input.brandProfile).join('\n'));
  const citationEvidence = canonicalize(input.citations.map((item) => item.claimText).join('\n'));

  addFormatIssues(issues, input);
  addBrandIssues(issues, input);
  addOfficialSiteTechnicalIssues(issues, input);

  for (const section of contentSections(input.content)) {
    for (const rule of RISK_RULES) {
      if (!rule.pattern.test(section.text)) continue;
      const evidence =
        rule.support === 'citation'
          ? citationEvidence
          : rule.support === 'brand_or_citation'
            ? `${brandEvidence}\n${citationEvidence}`
            : '';
      if (rule.support !== 'never' && hasMatchingEvidence(section.text, evidence)) continue;
      issues.push(
        issue(rule.ruleId, rule.category, section.location, rule.message, rule.suggestion),
      );
    }
  }
  return Object.freeze(deduplicate(issues));
}

export function mergeDeterministicRiskIssues(
  assessment: QualityCheckerData,
  deterministicIssues: readonly QualityIssue[],
): QualityCheckerData {
  if (deterministicIssues.length === 0) return assessment;
  const issues = deduplicate([...assessment.issues, ...deterministicIssues]);
  return Object.freeze({
    ...assessment,
    decision: issues.some((item) => item.severity === 'BLOCK') ? 'block' : assessment.decision,
    issues: Object.freeze(issues),
  });
}

function addFormatIssues(issues: QualityIssue[], input: DeterministicRiskScanInput): void {
  const title = input.content['title'];
  if (input.content['platform_code'] !== input.platformCode) {
    issues.push(
      issue(
        'deterministic.format.platform_mismatch',
        'format',
        'platform_code',
        '内容平台与当前平台任务不一致。',
        '使用当前平台对应的内容版本。',
      ),
    );
  }
  if (typeof title !== 'string' || title.trim().length === 0) {
    issues.push(
      issue(
        'deterministic.format.title_required',
        'format',
        'title',
        '标题不能为空。',
        '补充清晰、可读的文章标题。',
      ),
    );
    return;
  }
  const length = [...title.trim()].length;
  if (length > TITLE_LIMITS[input.platformCode]) {
    issues.push(
      issue(
        `deterministic.${input.platformCode}.title_max_length`,
        'format',
        'title',
        `标题为 ${length} 字，超过当前平台 ${TITLE_LIMITS[input.platformCode]} 字的上限。`,
        '压缩标题，保留主题与核心结论。',
      ),
    );
  }
  if (input.platformCode === 'official_site' && length < 20) {
    issues.push(
      issue(
        'deterministic.official_site.title_min_length',
        'format',
        'title',
        `官网标题为 ${length} 字，少于 20 字。`,
        '补充主题、适用对象或核心价值，使标题达到 20–60 字。',
      ),
    );
  }
}

function addBrandIssues(issues: QualityIssue[], input: DeterministicRiskScanInput): void {
  const banned = Array.isArray(input.brandProfile['banned'])
    ? input.brandProfile['banned'].filter((item): item is string => typeof item === 'string')
    : [];
  if (banned.length === 0) return;
  const sections = contentSections(input.content);
  for (const phrase of banned) {
    const normalized = phrase.trim().toLocaleLowerCase('zh-CN');
    if (!normalized) continue;
    const matched = sections.find((section) =>
      section.text.toLocaleLowerCase('zh-CN').includes(normalized),
    );
    if (!matched) continue;
    issues.push(
      issue(
        'deterministic.brand.banned_phrase',
        'brand',
        matched.location,
        `内容包含企业禁用表述：“${phrase}”。`,
        '删除该表述，并按已发布品牌档案改写。',
      ),
    );
  }
}

function addOfficialSiteTechnicalIssues(
  issues: QualityIssue[],
  input: DeterministicRiskScanInput,
): void {
  if (input.platformCode !== 'official_site') return;
  const meta = record(input.content['platform_meta']);
  const faq = meta && Array.isArray(meta['faq']) ? meta['faq'] : [];
  const schemaOrg = meta ? record(meta['schema_org']) : null;
  const required: readonly [boolean, string, string, string][] = [
    [
      Boolean(meta && nonBlank(meta['slug'])),
      'deterministic.official_site.slug_required',
      'platform_meta.slug',
      '官网内容缺少可发布的 URL slug。',
    ],
    [
      Boolean(meta && nonBlank(meta['meta_description'])),
      'deterministic.official_site.meta_description_required',
      'platform_meta.meta_description',
      '官网内容缺少搜索摘要。',
    ],
    [
      faq.length > 0,
      'deterministic.official_site.faq_required',
      'platform_meta.faq',
      '官网内容缺少常见问题。',
    ],
    [
      schemaOrg?.['@context'] === 'https://schema.org' && nonBlank(schemaOrg['@type']),
      'deterministic.official_site.schema_org_required',
      'platform_meta.schema_org',
      '官网内容缺少有效的 Schema.org JSON-LD。',
    ],
  ];
  for (const [valid, ruleId, location, message] of required) {
    if (valid) continue;
    issues.push(
      issue(
        ruleId,
        'format',
        location,
        message,
        '重新生成官网平台数据，补齐 slug、搜索摘要、FAQ 和 Schema.org。',
      ),
    );
  }
}

function hasMatchingEvidence(value: string, evidence: string): boolean {
  if (!evidence) return false;
  const normalized = canonicalize(value);
  if (normalized.length >= 8 && evidence.includes(normalized)) return true;
  const tokens = sensitiveValueTokens(value);
  return tokens.length > 0 && tokens.every((token) => evidence.includes(token));
}

function sensitiveValueTokens(value: string): readonly string[] {
  const matches = [
    ...value.matchAll(/(?:\+?86[-\s]?)?1[3-9]\d{9}|0\d{2,3}[-\s]?\d{7,8}/gu),
    ...value.matchAll(/(?:¥|￥)\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*元/gu),
    ...value.matchAll(
      /(?:\d+(?:\.\d+)?(?:\+|余|多|以上)?|数十|近百|上百|数百)\s*(?:台|辆|人|名|家|个|单|次|年)/gu,
    ),
  ];
  return [...new Set(matches.map((match) => canonicalize(match[0])))];
}

function contentSections(content: Readonly<Record<string, unknown>>): readonly LocatedText[] {
  const sections: LocatedText[] = [];
  for (const key of ['title', 'summary', 'cta'] as const) {
    const value = content[key];
    if (typeof value === 'string' && value.trim()) {
      sections.push({ location: key, text: value });
    }
  }
  const blocks = Array.isArray(content['blocks']) ? content['blocks'] : [];
  for (const [index, value] of blocks.entries()) {
    const block = record(value);
    const text = block?.['text'];
    if (typeof text !== 'string' || !text.trim()) continue;
    const key = typeof block?.['block_key'] === 'string' ? block['block_key'] : String(index + 1);
    sections.push({ location: `blocks.${key}`, text });
  }
  collectObjectStrings(content['platform_meta'], 'platform_meta', sections);
  return sections;
}

function collectObjectStrings(value: unknown, path: string, output: LocatedText[]): void {
  if (typeof value === 'string') {
    if (value.trim()) output.push({ location: path, text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectObjectStrings(item, `${path}.${index}`, output));
    return;
  }
  const object = record(value);
  if (!object) return;
  for (const [key, item] of Object.entries(object)) {
    collectObjectStrings(item, `${path}.${key}`, output);
  }
}

function flattenStrings(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(flattenStrings);
  const object = record(value);
  return object ? Object.values(object).flatMap(flattenStrings) : [];
}

function canonicalize(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/(\d+)(?:\+|余|多|以上)(?=(?:台|辆|人|名|家|个|单|次|年))/gu, '$1')
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function issue(
  ruleId: string,
  category: QualityIssue['category'],
  location: string,
  message: string,
  suggestion: string,
): QualityIssue {
  return Object.freeze({
    category,
    citation_ids: Object.freeze([]),
    location,
    message,
    rule_id: ruleId,
    severity: 'BLOCK',
    suggestion,
  });
}

function deduplicate(issues: readonly QualityIssue[]): QualityIssue[] {
  const seen = new Set<string>();
  return issues.filter((item) => {
    const key = `${item.rule_id}:${item.location ?? ''}:${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function nonBlank(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}
