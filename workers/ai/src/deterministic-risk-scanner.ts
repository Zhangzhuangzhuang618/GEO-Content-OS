import {
  ALLOWED_COMPANY_NAME,
  findDisallowedCompanyNames,
  type PlatformCode,
} from '@geo-content-os/contracts';
import type { QualityCheckerData, QualityIssue } from '@geo-content-os/contracts/skills';

export interface DeterministicRiskCitation {
  readonly id: string;
  readonly quoteText: string;
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
  sohu: 72,
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
    pattern:
      /(?:¥|￥)\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:元|块|万元)|(?:价格|报价|收费|费用)[^。；;\n]{0,16}\d+(?:\.\d+)?\s*(?:元|块|万元)/u,
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
    pattern:
      /(?:地址|位于|坐落于)[：:\s]*[^。；;\n]{3,40}(?:路|街|大道|巷|(?<![型编账序信口])号|大厦|园区)/u,
    ruleId: 'deterministic.fact.unsupported_address',
    suggestion: '删除详细地址，或先在已发布企业档案中确认。',
    support: 'brand_or_citation',
  },
  {
    category: 'fact',
    message: '内容包含未在企业档案或证据中核验的企业规模或经营数量。',
    pattern:
      /(?:(?:自有|拥有|现有|累计)[^。；;\n]{0,24}?|(?:公司|企业|团队|车队)[^。；;\n]{0,16}?配备[^。；;\n]{0,12}?|(?:员工|师傅|车辆|车队|客户)(?:数量|规模|总数|累计)?(?:达到|超过|约|近|共|为|达|有)?\s*)(?:\d+(?:\.\d+)?(?:\+|余|多|以上)?|数十|近百|上百|数百)\s*(?:台|辆|人|名|家|个|单|次|年)/u,
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
  const brandEvidence = flattenStrings(input.brandProfile).join('\n');
  const citationEvidence = input.citations.map((item) => item.quoteText).join('\n');

  addFormatIssues(issues, input);
  addBrandIssues(issues, input);
  addCompanyNameIssues(issues, input);
  addOfficialSiteTechnicalIssues(issues, input);
  addBaijiahaoPlatformIssues(issues, input);

  for (const section of contentSections(input.content)) {
    for (const rule of RISK_RULES) {
      const evidence =
        rule.support === 'citation'
          ? citationEvidence
          : rule.support === 'brand_or_citation'
            ? `${brandEvidence}\n${citationEvidence}`
            : '';
      for (const matchedText of matchingClaims(section.text, rule.pattern)) {
        if (rule.support !== 'never' && hasMatchingEvidence(matchedText, evidence)) continue;
        issues.push(
          issue(
            rule.ruleId,
            rule.category,
            section.location,
            `${rule.message} 命中表述：“${summarizeMatch(matchedText)}”`,
            rule.suggestion,
          ),
        );
      }
    }
  }
  return Object.freeze(deduplicate(issues));
}

function addBaijiahaoPlatformIssues(
  issues: QualityIssue[],
  input: DeterministicRiskScanInput,
): void {
  if (input.platformCode !== 'baijiahao') return;
  const title = typeof input.content['title'] === 'string' ? input.content['title'].trim() : '';
  if ([...title].length < 2) {
    issues.push(
      issue(
        'deterministic.baijiahao.title_min_length',
        'format',
        'title',
        '百家号标题少于 2 个字符。',
        '补充能够直接表达用户问题或文章结论的标题。',
      ),
    );
  }
  const meta = record(input.content['platform_meta']);
  const abstract = meta && typeof meta['abstract'] === 'string' ? meta['abstract'].trim() : '';
  const tags = meta && Array.isArray(meta['tags']) ? meta['tags'] : [];
  if ([...abstract].length < 1 || [...abstract].length > 120) {
    issues.push(
      issue(
        'deterministic.baijiahao.abstract_length',
        'format',
        'platform_meta.abstract',
        '百家号摘要必须为 1–120 个字符。',
        '重写摘要，保持信息完整且不超过 120 个字符。',
      ),
    );
  }
  if (
    tags.length < 3 ||
    tags.length > 8 ||
    tags.some((tag) => typeof tag !== 'string' || !tag.trim()) ||
    new Set(tags).size !== tags.length
  ) {
    issues.push(
      issue(
        'deterministic.baijiahao.tag_count',
        'format',
        'platform_meta.tags',
        '百家号标签必须为 3–8 个不重复的非空标签。',
        '按主题、用户问题和地域补充 3–8 个准确标签。',
      ),
    );
  }
  const blocks = Array.isArray(input.content['blocks']) ? input.content['blocks'] : [];
  const parsedBlocks = blocks.filter(record);
  const body = contentSections(input.content)
    .map((section) => section.text)
    .join('\n');
  const readable = parsedBlocks
    .map((block) => (typeof block['text'] === 'string' ? block['text'] : ''))
    .join('\n')
    .replace(/[\s\p{P}\p{S}]/gu, '').length;
  const headings = parsedBlocks.filter((block) => block['block_type'] === 'heading').length;
  const lists = parsedBlocks.filter((block) => block['block_type'] === 'list').length;
  if (readable < 850 || parsedBlocks.length < 7 || headings < 2 || lists < 1) {
    issues.push(
      issue(
        'deterministic.baijiahao.structure_minimum',
        'format',
        'blocks',
        '百家号正文未达到 850 个有效字符、7 个内容块、2 个分节标题和 1 个清单的最低结构。',
        '补充有事实边界的解释、步骤和清单，不得重复填充。',
      ),
    );
  }
  if (
    input.content['cta'] !== null ||
    parsedBlocks.some((block) => block['block_type'] === 'cta')
  ) {
    issues.push(
      issue(
        'deterministic.baijiahao.cta_forbidden',
        'compliance',
        'cta',
        '百家号自动发布内容不得包含官网 CTA 或 CTA 内容块。',
        '删除 CTA，只保留中性的信息总结。',
      ),
    );
  }
  const prohibitedPatterns: readonly [RegExp, string, string][] = [
    [/(?:https?:\/\/|www\.)\S+/iu, 'external_url', '第三方网址'],
    [/(?:二维码|扫码(?:关注|咨询|添加|联系)?)/u, 'qr_code', '二维码或扫码导流'],
    [
      /(?:微信|微博|抖音|小红书|公众号|QQ)\s*(?:号|账号|ID|：|:)/iu,
      'external_account',
      '外部平台账号',
    ],
    [
      /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)|(?<!\d)0\d{2,3}[-\s]?\d{7,8}(?!\d)/u,
      'phone',
      '营销电话',
    ],
    [
      /(?:推广水印|广告水印|加微信|联系电话).{0,12}(?:水印|角标)?/u,
      'promotional_watermark',
      '推广水印',
    ],
  ];
  for (const [pattern, code, label] of prohibitedPatterns) {
    if (!pattern.test(body)) continue;
    issues.push(
      issue(
        `deterministic.baijiahao.${code}_forbidden`,
        'compliance',
        'blocks',
        `百家号内容包含禁止的${label}。`,
        `删除${label}，不得改用隐晦写法规避规则。`,
      ),
    );
  }
  const ambiguousTime = contentSections(input.content).find(
    (section) =>
      /(?:今天|昨天|明天|近日|近期|今年|去年|明年|本月|上月|下月)/u.test(section.text) &&
      !/(?:19|20)\d{2}(?:年(?:\d{1,2}月(?:\d{1,2}日)?)?|[-/.]\d{1,2}(?:[-/.]\d{1,2})?)/u.test(
        section.text,
      ),
  );
  if (ambiguousTime) {
    issues.push(
      issue(
        'deterministic.baijiahao.relative_time_ambiguous',
        'fact',
        ambiguousTime.location,
        '相对时间表述缺少明确年份或日期，不能作为最新信息发布。',
        '删除相对时间，或在同一字段中补充可核验的绝对日期。',
      ),
    );
  }
}

export function mergeDeterministicRiskIssues(
  assessment: QualityCheckerData,
  deterministicIssues: readonly QualityIssue[],
  content?: Readonly<Record<string, unknown>>,
): QualityCheckerData {
  const modelIssues = content
    ? assessment.issues.filter((item) => keepModelIssue(item, content))
    : assessment.issues;
  const issues = deduplicate([...modelIssues, ...deterministicIssues]);
  const removedBlockingIssue =
    modelIssues.length !== assessment.issues.length &&
    assessment.issues.some((item) => item.severity === 'BLOCK' && !modelIssues.includes(item));
  const decision = issues.some((item) => item.severity === 'BLOCK')
    ? 'block'
    : removedBlockingIssue && assessment.decision === 'block'
      ? issues.length === 0
        ? 'pass'
        : 'revise'
      : assessment.decision;
  if (
    deterministicIssues.length === 0 &&
    modelIssues.length === assessment.issues.length &&
    decision === assessment.decision
  ) {
    return assessment;
  }
  return Object.freeze({
    ...assessment,
    decision,
    issues: Object.freeze(issues),
  });
}

function keepModelIssue(issue: QualityIssue, content: Readonly<Record<string, unknown>>): boolean {
  if (issue.rule_id !== 'brand.other_company_name') return true;
  const quotedNames = [...issue.message.matchAll(/[“"]([^”"]{2,80})[”"]/gu)].map((match) =>
    match[1]!.trim(),
  );
  if (quotedNames.length === 0) return false;
  const contentText = flattenStrings(content).join('\n');
  return quotedNames.some((name) => !isAllowedCompanyReference(name) && contentText.includes(name));
}

function isAllowedCompanyReference(value: string): boolean {
  return (
    value === ALLOWED_COMPANY_NAME ||
    value === '某公司' ||
    value === '某搬家公司' ||
    value === '其他服务商'
  );
}

function addCompanyNameIssues(issues: QualityIssue[], input: DeterministicRiskScanInput): void {
  for (const section of contentSections(input.content)) {
    for (const companyName of findDisallowedCompanyNames(section.text)) {
      issues.push(
        issue(
          'deterministic.brand.other_company_name',
          'brand',
          section.location,
          `内容包含不允许公开的其他企业或品牌名称：“${companyName}”。`,
          `删除该名称，或改为“某公司”“某搬家公司”“其他服务商”等匿名表述；只允许出现“${ALLOWED_COMPANY_NAME}”。`,
        ),
      );
    }
  }
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
  const tokens = sensitiveValueTokens(value);
  if (tokens.length > 0) {
    const evidenceTokens = new Set(sensitiveValueTokens(evidence));
    return tokens.every((token) => evidenceTokens.has(token));
  }
  const normalized = canonicalize(value);
  return normalized.length >= 4 && canonicalize(evidence).includes(normalized);
}

function matchingClaims(value: string, pattern: RegExp): readonly string[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return Object.freeze(
    [...value.matchAll(new RegExp(pattern.source, flags))]
      .map((match) => match[0].trim())
      .filter(Boolean),
  );
}

function summarizeMatch(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return [...normalized].slice(0, 80).join('');
}

function sensitiveValueTokens(value: string): readonly string[] {
  const matches = [
    ...value.matchAll(/(?:\+?86[-\s]?)?1[3-9]\d{9}|0\d{2,3}[-\s]?\d{7,8}/gu),
    ...value.matchAll(
      /(?:\d+(?:\.\d+)?(?:\+|余|多|以上)?|数十|近百|上百|数百)\s*(?:台|辆|人|名|家|个|单|次|年)/gu,
    ),
  ];
  return [
    ...new Set([...matches.map((match) => canonicalize(match[0])), ...monetaryValueTokens(value)]),
  ];
}

function monetaryValueTokens(value: string): readonly string[] {
  const tokens: string[] = [];
  for (const match of value.matchAll(
    /(?:¥|￥)\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(万元|元|块钱|块)/gu,
  )) {
    const amount = match[1] ?? match[2];
    const unit = match[3] ?? '元';
    if (amount) tokens.push(monetaryToken(amount, unit));
  }
  for (const match of value.matchAll(
    /(\d+(?:\.\d+)?(?:\s*[/／、]\s*\d+(?:\.\d+)?)+)\s*(万元|元|块钱|块)/gu,
  )) {
    const amounts = match[1];
    const unit = match[2];
    if (!amounts || !unit) continue;
    for (const amount of amounts.split(/\s*[/／、]\s*/u)) {
      tokens.push(monetaryToken(amount, unit));
    }
  }
  return [...new Set(tokens)];
}

function monetaryToken(amount: string, unit: string): string {
  return `money:${unit === '万元' ? '万元' : '元'}:${Number(amount)}`;
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
  return sections.filter((section) => !isTechnicalMetadataLocation(section.location));
}

function isTechnicalMetadataLocation(location: string): boolean {
  return (
    location === 'platform_meta.slug' ||
    location === 'platform_meta.schema_org.@context' ||
    location === 'platform_meta.schema_org.@type'
  );
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
