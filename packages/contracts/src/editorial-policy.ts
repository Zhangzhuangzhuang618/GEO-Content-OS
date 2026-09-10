import { z } from 'zod';

/** The first release deliberately excludes every other publishing platform. */
export const EDITORIAL_PLATFORM_CODES = ['official_site', 'lieju', 'douyin'] as const;
export const EditorialPlatformSchema = z.enum(EDITORIAL_PLATFORM_CODES);
export const ContentStyleSchema = z.enum(['standard', 'company_recommendation']);
export type ContentStyle = z.infer<typeof ContentStyleSchema>;
export type EditorialPlatform = z.infer<typeof EditorialPlatformSchema>;
export const EditorialGenerationTargetsSchema = z
  .object({
    official_site: z
      .object({ account_id: z.uuid(), content_style: ContentStyleSchema.optional() })
      .strict()
      .optional(),
    lieju: z
      .object({ account_id: z.uuid(), content_style: ContentStyleSchema.optional() })
      .strict()
      .optional(),
    douyin: z
      .object({ account_id: z.uuid(), content_style: ContentStyleSchema.optional() })
      .strict()
      .optional(),
  })
  .strict();
export type EditorialGenerationTargets = z.infer<typeof EditorialGenerationTargetsSchema>;

const unique = (values: readonly string[]) => new Set(values).size === values.length;
const sourceIds = z.array(z.uuid()).max(12).refine(unique, '资料不能重复');
export const RecommendedCompanySchema = z
  .object({
    id: z.uuid(),
    legal_name: z
      .string()
      .trim()
      .min(4)
      .max(80)
      .regex(
        /^[\p{Script=Han}A-Za-z0-9（）()·]+(?:有限责任公司|股份有限公司|有限公司|股份公司|集团公司)$/u,
        '请填写完整法定企业名称',
      ),
    source_document_ids: sourceIds,
    evidence_mode: z.enum(['documents', 'primary', 'inherit_primary', 'description']).optional(),
    business_description: z
      .string()
      .trim()
      .max(4000)
      // Reject non-text control bytes while allowing ordinary line breaks and tabs.
      // eslint-disable-next-line no-control-regex
      .regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f]*$/u)
      .optional(),
    description_source_id: z.uuid().optional(),
  })
  .strict();
export const RecommendedCompaniesSchema = z
  .array(RecommendedCompanySchema)
  .max(6)
  .refine((items) => unique(items.map((item) => item.id)), '推荐企业条目不能重复')
  .refine((items) => unique(items.map((item) => item.legal_name)), '推荐企业名称不能重复');

export const AccountContentPolicyRequestSchema = z
  .object({
    default_style: ContentStyleSchema,
    expected_version: z.number().int().nonnegative(),
    recommended_companies: z
      .array(RecommendedCompanySchema.omit({ description_source_id: true }))
      .max(6)
      .refine((items) => unique(items.map((item) => item.id)), '推荐企业条目不能重复')
      .refine((items) => unique(items.map((item) => item.legal_name)), '推荐企业名称不能重复'),
  })
  .strict();
export const AccountContentPolicyViewSchema = z
  .object({
    account_id: z.uuid(),
    default_style: ContentStyleSchema,
    platform_code: EditorialPlatformSchema,
    recommended_companies: RecommendedCompaniesSchema,
    version: z.number().int().nonnegative(),
    workspace_id: z.uuid(),
    primary_company_name: z.string().nullable().optional(),
  })
  .strict();

/** Stored outside customer-editable content_json; only the server may create it. */
export const EditorialContextSchema = z
  .object({
    account_id: z.uuid(),
    companies: RecommendedCompaniesSchema,
    platform_code: EditorialPlatformSchema,
    policy_version: z.number().int().nonnegative(),
    schema_version: z.literal('editorial-context@1'),
    style: ContentStyleSchema,
    template_version: z.literal('company-recommendation@1'),
    evidence_resolved: z.boolean().optional(),
    primary_company_name: z.string().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.style === 'company_recommendation' &&
      (value.companies.length < 2 ||
        value.companies.some(
          (company) =>
            company.source_document_ids.length === 0 &&
            !company.description_source_id &&
            !['primary', 'inherit_primary'].includes(company.evidence_mode ?? 'documents'),
        ))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['companies'],
        message: '硬广需要 2–6 家企业；其他企业请填写业务说明、沿用主公司服务或绑定资料。',
      });
    }
    if (value.style === 'standard' && value.companies.length !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['companies'],
        message: '常规内容不使用推荐企业名单。',
      });
    }
  });
export type EditorialContext = z.infer<typeof EditorialContextSchema>;
export type RecommendedCompany = z.infer<typeof RecommendedCompanySchema>;
export type AccountContentPolicyRequest = z.infer<typeof AccountContentPolicyRequestSchema>;
export type AccountContentPolicyView = z.infer<typeof AccountContentPolicyViewSchema>;

export function recommendationEvidenceModeInstruction(context: EditorialContext): string {
  const inherited = context.companies.filter(
    (company) => company.evidence_mode === 'inherit_primary',
  );
  if (!inherited.length) return '';
  return `管理员已明确确认以下企业沿用主公司的服务范围和流程：${inherited.map((company) => company.legal_name).join('、')}。这些企业绑定的主公司服务引用可支持相同服务和操作流程，不因来源中的主公司名称而拒绝这一已授权服务事实。此授权不包含证照、保险、奖项、成立年限、人员车辆归属、独占案例、具体价格或保障承诺；这些信息仍须该推荐公司自己的资料支持。每家公司仍先说明承接业务，再各展开一个相关细节，不复制整段流程。不在客户正文说明沿用、管理员确认或共同经营关系。`;
}

/** Select complete sentences in source order; never drop a condition or negation inside one. */
export function isRecommendationCardExcerpt(body: string, cardBody: string): boolean {
  const sentences = (value: string) =>
    value
      .split(/[。！？!?；;\n]+/u)
      .map((part) => part.trim())
      .filter(Boolean);
  const source = sentences(body);
  const selected = sentences(cardBody);
  if (!selected.length) return false;
  let cursor = 0;
  for (const sentence of selected) {
    const index = source.indexOf(sentence, cursor);
    if (index < 0) return false;
    cursor = index + 1;
  }
  return true;
}

export function supportsEditorialStyle(platform: string): platform is EditorialPlatform {
  return EditorialPlatformSchema.safeParse(platform).success;
}

export function storedEditorialContext(value: unknown, platform: string): EditorialContext | null {
  if (value === null || value === undefined || !supportsEditorialStyle(platform)) return null;
  const context = EditorialContextSchema.parse(value);
  if (context.platform_code !== platform) throw new Error('内容风格快照的平台不匹配');
  return context;
}

/** Checks customer content against a trusted version context; never reads context from content_json. */
export function assessCompanyRecommendation(
  value: unknown,
  context: EditorialContext | null,
): readonly string[] {
  if (!context || context.style !== 'company_recommendation') return [];
  const content = value as Record<string, unknown>;
  const blocks = (Array.isArray(content['blocks']) ? content['blocks'] : []) as {
    block_key: string;
    block_type: string;
    text: string;
  }[];
  const mappings = (Array.isArray(content['citation_map']) ? content['citation_map'] : []) as {
    claim_key: string;
    claim_text: string;
    citation_ids: string[];
  }[];
  const issues: string[] = [];
  const names = context.companies.map((company) => company.legal_name);
  const companyHeadings = blocks
    .filter((block) => /^company_\d+_heading$/u.test(block.block_key))
    .map((block) => block.text);
  if (JSON.stringify(companyHeadings) !== JSON.stringify(names))
    issues.push('推荐企业全称、数量或顺序与冻结名单不一致');
  for (const [index, company] of context.companies.entries()) {
    const key = `company_${index + 1}`;
    const paragraph = blocks.find((block) => block.block_key === key);
    if (
      !paragraph?.text ||
      !mappings.some(
        (item) =>
          item.claim_key === key &&
          item.claim_text === paragraph.text &&
          item.citation_ids?.length > 0,
      )
    ) {
      issues.push(`${company.legal_name} 的服务介绍缺少完整引用映射`);
    }
  }
  const meta = content['platform_meta'] as Record<string, unknown> | undefined;
  const visible = [
    content['title'],
    ...blocks.map((block) => block.text),
    meta?.['description'],
  ].join('\n');
  if (
    /独立测评|客观排名|权威榜单|亲测|亲身体验|我(?:上次|之前|已经).{0,15}(?:搬家|用过)|旗下公司|集团旗下/u.test(
      visible,
    )
  )
    issues.push('企业推荐不得伪装独立排名、虚构消费经历或集团归属');
  if (context.platform_code === 'douyin') {
    const cards = (Array.isArray(meta?.['cards']) ? meta['cards'] : []).filter(record);
    for (const [index, company] of context.companies.entries()) {
      const key = `company_${index + 1}`;
      const matching = cards.filter((card) => card['card_key'] === key);
      const body = matching[0]?.['body'];
      const prefix = `${company.legal_name}：`;
      const paragraph = blocks.find((block) => block.block_key === key);
      if (
        matching.length !== 1 ||
        typeof body !== 'string' ||
        !body.startsWith(prefix) ||
        !isRecommendationCardExcerpt(paragraph?.text ?? '', body.slice(prefix.length))
      )
        issues.push(
          `${company.legal_name} 的卡片事实须摘选对应正文完整句子，不得删改条件、否定或公司归属`,
        );
    }
    const description = typeof meta?.['description'] === 'string' ? meta['description'] : '';
    let previous = -1;
    for (const name of names) {
      const position = description.indexOf(name);
      if (position <= previous || description.split(name).length - 1 !== 1)
        issues.push(`抖音主文案须按顺序介绍 ${name}，全称仅出现一次`);
      previous = position;
    }
    const paragraphs = description.split(/\n\s*\n/u).filter((text) => text.trim());
    if (paragraphs.length < names.length + 2 || paragraphs.length > names.length + 4)
      issues.push('抖音推荐主文案应包含场景开头、每家公司单独一段、核对清单和结尾');
  }
  return issues;
}

export function resolveEditorialStyle(
  accountDefault: ContentStyle = 'standard',
  dailyOverride?: ContentStyle | null,
  requestOverride?: ContentStyle | null,
): ContentStyle {
  return requestOverride ?? dailyOverride ?? accountDefault;
}

export function freezeEditorialContext(
  policy: AccountContentPolicyView,
  dailyOverride?: ContentStyle | null,
  requestOverride?: ContentStyle | null,
): EditorialContext {
  const style = resolveEditorialStyle(policy.default_style, dailyOverride, requestOverride);
  return EditorialContextSchema.parse({
    account_id: policy.account_id,
    companies: style === 'company_recommendation' ? policy.recommended_companies : [],
    platform_code: policy.platform_code,
    policy_version: policy.version,
    schema_version: 'editorial-context@1',
    style,
    template_version: 'company-recommendation@1',
  });
}

/** Pass a database/server-owned context, never a field extracted from a model's content. */
export function editorialAllowedCompanyNames(
  ownerNames: readonly string[],
  context: EditorialContext | null,
): readonly string[] {
  return [
    ...new Set([
      ...ownerNames,
      ...(context?.style === 'company_recommendation'
        ? context.companies.map((company) => company.legal_name)
        : []),
    ]),
  ];
}

export function readWriterEditorialContext(
  input: unknown,
  platform: string,
): EditorialContext | null {
  if (!supportsEditorialStyle(platform) || !record(input)) return null;
  const brief = input['brief'];
  if (!record(brief) || !record(brief['constraints'])) return null;
  const constraints = brief['constraints'];
  const contexts = constraints['editorial_contexts_by_code'];
  if (!record(contexts) || contexts[platform] === undefined) return null;
  const context = EditorialContextSchema.parse(contexts[platform]);
  const targets = constraints['target_accounts_by_code'];
  const target = record(targets) ? targets[platform] : null;
  if (
    context.platform_code !== platform ||
    !record(target) ||
    target['account_id'] !== context.account_id
  ) {
    throw new Error('生文风格上下文与目标账号不一致。');
  }
  return context;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
