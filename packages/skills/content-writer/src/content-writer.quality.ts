import {
  findLiejuForbiddenContactDetails,
  findLiejuProhibitedPromotionalTerms,
} from '@geo-content-os/contracts';
import type {
  ContentWriterContent,
  ContentWriterData,
  ContentWriterPlatformCode,
} from '@geo-content-os/contracts/skills';

export type ContentGenerationPolicy = 'balanced' | 'fast' | 'quality';

export interface ContentQualityAssessment {
  readonly issues: readonly string[];
  readonly passed: boolean;
}

interface QualityTarget {
  readonly characters: number;
  readonly headings: number;
  readonly lists: number;
  readonly blocks: number;
}

const TARGETS: Readonly<Record<ContentWriterPlatformCode, QualityTarget>> = Object.freeze({
  master: { blocks: 8, characters: 1_300, headings: 3, lists: 1 },
  official_site: { blocks: 8, characters: 1_300, headings: 3, lists: 1 },
  baijiahao: { blocks: 7, characters: 850, headings: 2, lists: 1 },
  sohu: { blocks: 7, characters: 850, headings: 2, lists: 1 },
  lieju: { blocks: 5, characters: 600, headings: 1, lists: 1 },
  toutiao: { blocks: 7, characters: 850, headings: 2, lists: 1 },
  zhihu: { blocks: 8, characters: 1_100, headings: 3, lists: 1 },
  xiaohongshu: { blocks: 7, characters: 500, headings: 2, lists: 1 },
  wechat_mp: { blocks: 8, characters: 1_300, headings: 3, lists: 1 },
  douyin: { blocks: 8, characters: 420, headings: 2, lists: 1 },
});

const POLICY_FACTOR: Readonly<Record<ContentGenerationPolicy, number>> = Object.freeze({
  fast: 0.45,
  balanced: 0.8,
  quality: 1,
});

const PLACEHOLDER_PATTERNS = [
  /依据当前品牌策略与内容简报生成/u,
  /请在发布前完成事实复核/u,
  /暂无内容/u,
  /待补充/u,
] as const;

const UNSUPPORTED_AUTHORITY_PATTERNS = [
  /权威(?:榜单|排名|测评)/u,
  /全网第[一1]/u,
  /行业第[一1]/u,
  /百分之百/u,
  /100%/u,
  /基本不会踩(?:坑|雷)/u,
  /保证(?:不会|没有|无)/u,
] as const;

const DOUYIN_DESCRIPTION_MINIMUM = 420;
const DOUYIN_DESCRIPTION_MAXIMUM = 900;
const DOUYIN_DESCRIPTION_PARAGRAPH_MINIMUM = 5;
const DOUYIN_DESCRIPTION_PARAGRAPH_MAXIMUM = 8;
const DOUYIN_PAIN_PATTERN =
  /涉及|容易|可能|常见|遇到|损伤|延误|混乱|加价|停工|风险|难点|麻烦|遗漏|不足|卡住/u;
const DOUYIN_SOLUTION_PATTERN = /勘测|核对|记录|评估|确认|检查|清点|测量|规划/u;
const DOUYIN_PRICE_BOUNDARY_PATTERN = /报价|费用|计费|收费|服务范围|服务边界|书面约定/u;
const DOUYIN_PROTECTION_PATTERN = /防护|包装|加固|保障|损坏|磕碰|风险|责任|验收/u;
const DOUYIN_SCHEDULE_PATTERN = /预约|响应|排期|工期|停工|调度|时间|进场|出场/u;
const DOUYIN_CONCLUSION_PATTERN = /结合|对照|综合|核对|确认|选择|判断|降低|避免|减少/u;
const DOUYIN_ASSISTANT_FLAVOR_PATTERNS = [
  /^\s*(?:先说结论|直接说结论|这次只看)/u,
  /真正(?:决定|重要|关键)[^。！？!?]{0,60}(?:不是|并非)[^。！？!?]{0,60}(?:而是|是)/u,
  /(?:^|[。！？!?\n])(?:下面(?:我们)?(?:来)?|接下来(?:我们)?)(?:看|说|介绍|分析|梳理)|总的来说|综上所述|希望(?:以上|这些).{0,16}(?:帮助|参考)/u,
  /以上(?:内容|流程|建议).{0,24}(?:仅供参考|来自公开|整理)/u,
] as const;

export function assessContentWriterData(
  data: ContentWriterData,
  policy: ContentGenerationPolicy,
): ContentQualityAssessment {
  return assessContentWriterContents([data.master_content, ...data.variants], policy);
}

export function assessContentWriterContents(
  contents: readonly ContentWriterContent[],
  policy: ContentGenerationPolicy,
): ContentQualityAssessment {
  const issues = contents.flatMap((content) => assessContent(content, policy));
  return Object.freeze({ issues: Object.freeze(issues), passed: issues.length === 0 });
}

function assessContent(
  content: ContentWriterContent,
  policy: ContentGenerationPolicy,
): readonly string[] {
  const target = TARGETS[content.platform_code];
  const factor = POLICY_FACTOR[policy];
  const text = content.blocks
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n');
  const characters = countReadableCharacters(text);
  const headings = content.blocks.filter((block) => block.block_type === 'heading').length;
  const lists = content.blocks.filter((block) => block.block_type === 'list').length;
  const required = (value: number): number => Math.max(1, Math.ceil(value * factor));
  const issues: string[] = [];

  if (content.platform_code === 'official_site') {
    const titleLength = [...content.title.trim()].length;
    if (titleLength < 20 || titleLength > 60) {
      issues.push(`official_site:标题为 ${titleLength} 个字符，必须为 20–60 个字符`);
    }
  }

  if (content.platform_code === 'douyin') {
    issues.push(...douyinImageNoteIssues(content));
  }

  if (characters < required(target.characters)) {
    issues.push(
      `${content.platform_code}:正文仅 ${characters} 个有效字符，至少需要 ${required(target.characters)} 个`,
    );
  }
  if (content.blocks.length < required(target.blocks)) {
    issues.push(
      `${content.platform_code}:仅 ${content.blocks.length} 个内容块，至少需要 ${required(target.blocks)} 个`,
    );
  }
  if (headings < Math.floor(target.headings * factor)) {
    issues.push(`${content.platform_code}:缺少清晰的分节标题`);
  }
  if (lists < Math.floor(target.lists * factor)) {
    issues.push(`${content.platform_code}:缺少可执行清单或比较项`);
  }
  if (
    new Set(content.blocks.map((block) => normalize(block.text))).size !== content.blocks.length
  ) {
    issues.push(`${content.platform_code}:存在重复内容块`);
  }
  if (
    PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(text)) &&
    characters < target.characters
  ) {
    issues.push(`${content.platform_code}:正文仍包含占位式表达`);
  }
  const unsupportedAuthorityTerms = UNSUPPORTED_AUTHORITY_PATTERNS.flatMap((pattern) => {
    const matched = pattern.exec(text)?.[0];
    return matched ? [matched] : [];
  });
  if (unsupportedAuthorityTerms.length > 0) {
    issues.push(
      `${content.platform_code}:包含高风险权威或绝对化表述（${[
        ...new Set(unsupportedAuthorityTerms),
      ].join('、')}），必须删除或改为有事实边界的客观表达`,
    );
  }
  if (content.platform_code === 'lieju') {
    const liejuPublishText = [content.title, content.summary, content.cta, text]
      .filter((value): value is string => typeof value === 'string')
      .join('\n');
    const prohibitedContactDetails = findLiejuForbiddenContactDetails(liejuPublishText);
    if (prohibitedContactDetails.length > 0) {
      const labels = [
        ...new Set(
          prohibitedContactDetails.map((finding) =>
            finding.kind === 'phone' ? '电话号码' : '微信或 QQ 账号',
          ),
        ),
      ];
      issues.push(
        `lieju:包含发布层禁止的具体联系方式（${labels.join(
          '、',
        )}），必须删除具体值；网址不属于此联系方式禁令`,
      );
    }
    const prohibitedTerms = findLiejuProhibitedPromotionalTerms(`${content.title}\n${text}`);
    if (prohibitedTerms.length > 0) {
      issues.push(
        `lieju:包含发布层禁止的宣传词（${prohibitedTerms.join(
          '、',
        )}），即使是否定、引用或举例也必须删除原词并改为中性表达`,
      );
    }
  }
  if (content.summary.trim() === content.blocks[0]?.text.trim()) {
    issues.push(`${content.platform_code}:摘要与正文首段完全重复`);
  }
  return issues;
}

function douyinImageNoteIssues(content: ContentWriterContent): readonly string[] {
  const issues: string[] = [];
  const titleLength = [...content.title.trim()].length;
  if (titleLength < 6 || titleLength > 26) {
    issues.push(`douyin:标题为 ${titleLength} 个字符，必须为 6–26 个字符`);
  }

  const meta = content.platform_meta;
  if (
    Object.keys(meta).some(
      (key) => !['cards', 'content_kind', 'description', 'topics'].includes(key),
    )
  ) {
    issues.push('douyin:platform_meta 只能包含 content_kind、description、topics 和 cards');
  }
  if (meta['content_kind'] !== 'image_note') {
    issues.push('douyin:platform_meta.content_kind 必须为 image_note');
  }
  const description = meta['description'];
  if (
    typeof description !== 'string' ||
    [...description.trim()].length < DOUYIN_DESCRIPTION_MINIMUM ||
    [...description.trim()].length > DOUYIN_DESCRIPTION_MAXIMUM
  ) {
    issues.push('douyin:platform_meta.description 必须为 420–900 个字符');
  } else {
    issues.push(...douyinNarrativeDescriptionIssues(content, description));
  }
  const topics = meta['topics'];
  if (
    !Array.isArray(topics) ||
    topics.length < 3 ||
    topics.length > 8 ||
    topics.some(
      (topic) =>
        typeof topic !== 'string' || topic.trim().length === 0 || [...topic.trim()].length > 40,
    ) ||
    new Set(topics.map((topic) => (typeof topic === 'string' ? topic.trim() : String(topic))))
      .size !== topics.length
  ) {
    issues.push('douyin:platform_meta.topics 必须包含 3–8 个不重复的有效话题');
  }

  const cards = meta['cards'];
  if (!Array.isArray(cards) || cards.length < 6 || cards.length > 9) {
    issues.push('douyin:platform_meta.cards 必须包含 6–9 张图文卡片');
    return issues;
  }
  const keys = new Set<string>();
  const validCards = cards.every((card, index) => {
    if (!record(card)) return false;
    const body = card['body'];
    const cardKey = card['card_key'];
    const heading = card['heading'];
    const kind = card['kind'];
    const headingLength = typeof heading === 'string' ? [...heading.trim()].length : 0;
    const bodyLength = typeof body === 'string' ? [...body.trim()].length : 0;
    const textLengthValid =
      kind === 'cover'
        ? headingLength >= 6 && headingLength <= 22 && bodyLength >= 12 && bodyLength <= 46
        : kind === 'summary'
          ? headingLength >= 4 && headingLength <= 16 && bodyLength >= 30 && bodyLength <= 96
          : headingLength >= 4 && headingLength <= 16 && bodyLength >= 24 && bodyLength <= 88;
    const valid =
      Object.keys(card).every((key) => ['body', 'card_key', 'heading', 'kind'].includes(key)) &&
      typeof body === 'string' &&
      typeof cardKey === 'string' &&
      /^[a-z0-9_-]{1,80}$/u.test(cardKey) &&
      !keys.has(cardKey) &&
      typeof heading === 'string' &&
      textLengthValid &&
      (kind === 'cover' || kind === 'body' || kind === 'summary') &&
      (index === 0
        ? kind === 'cover'
        : index === cards.length - 1
          ? kind === 'summary'
          : kind === 'body');
    if (typeof cardKey === 'string') keys.add(cardKey);
    return valid;
  });
  if (!validCards) {
    issues.push(
      'douyin:图文卡片必须按封面、正文、总结排序，且 card_key 唯一、标题简短、正文适合单页扫读',
    );
    return issues;
  }

  const normalizedCards = cards.map((card) => {
    const value = card as Readonly<Record<string, unknown>>;
    return `${String(value['heading'])}\n${String(value['body'])}`;
  });
  if (hasNearDuplicate(normalizedCards)) {
    issues.push('douyin:不同卡片存在同义重复，必须让每页提供新的判断或动作');
  }
  if (
    cards.some((card) => {
      const value = card as Readonly<Record<string, unknown>>;
      return /^(?:实用提示|实用指南|要点回顾|注意事项|温馨提示|内容总结|总结)$/u.test(
        String(value['heading']).trim(),
      );
    })
  ) {
    issues.push('douyin:卡片标题仍是通用模板词，必须改为该页的具体信息');
  }
  const cover = cards[0] as Readonly<Record<string, unknown>>;
  const coverText = `${String(cover['heading'])}${String(cover['body'])}`;
  if (!/[？?]|怎么|如何|先看|关键|避坑|清单|步骤|判断|别急/u.test(coverText)) {
    issues.push('douyin:封面缺少具体问题、收益或判断钩子');
  }
  const bodyText = cards
    .slice(1, -1)
    .map((card) => {
      const value = card as Readonly<Record<string, unknown>>;
      return `${String(value['heading'])}\n${String(value['body'])}`;
    })
    .join('\n');
  if (!/判断|标准|条件|取决|核对|选择|是否|先看/u.test(bodyText)) {
    issues.push('douyin:正文卡片缺少可执行的选择标准或判断条件');
  }
  if (!/步骤|先|再|准备|确认|检查|清点|预约|沟通|记录|核对/u.test(bodyText)) {
    issues.push('douyin:正文卡片缺少明确步骤或操作清单');
  }
  if (!/风险|避免|不要|不适合|注意|否则|边界|不能|可能|警惕/u.test(bodyText)) {
    issues.push('douyin:正文卡片缺少风险、不适用情形或事实边界');
  }
  return issues;
}

function douyinNarrativeDescriptionIssues(
  content: ContentWriterContent,
  description: string,
): readonly string[] {
  const issues: string[] = [];
  const paragraphs = descriptionParagraphs(description);
  if (
    paragraphs.length < DOUYIN_DESCRIPTION_PARAGRAPH_MINIMUM ||
    paragraphs.length > DOUYIN_DESCRIPTION_PARAGRAPH_MAXIMUM
  ) {
    issues.push('douyin:发布主文案必须使用 5–8 个长短有变化的自然段');
  }

  const openingSentences = sentenceTexts(paragraphs[0] ?? '');
  if (
    openingSentences.length !== 2 ||
    [...(openingSentences[0] ?? '')].length > 48 ||
    sharedMeaningfulCharacters(openingSentences[0] ?? '', content.title) < 2
  ) {
    issues.push('douyin:发布主文案第一段必须用第一句点题、第二句交代场景痛点');
  } else if (!DOUYIN_PAIN_PATTERN.test(openingSentences[1] ?? '')) {
    issues.push('douyin:发布主文案第二句话缺少具体对象、现实问题或后果');
  }

  const normalizedDescription = normalize(description);
  const duplicatedSource = [
    content.summary,
    ...content.blocks.map((block) => block.text),
    ...douyinCardTexts(content.platform_meta['cards']),
  ].some((value) => normalize(value) === normalizedDescription);
  if (duplicatedSource) {
    issues.push('douyin:发布主文案不得直接复制摘要、正文块或单张卡片');
  }

  if (!DOUYIN_SOLUTION_PATTERN.test(description)) {
    issues.push('douyin:发布主文案缺少可执行的现场核对或方案动作');
  }
  if (!DOUYIN_PRICE_BOUNDARY_PATTERN.test(description)) {
    issues.push('douyin:发布主文案缺少报价、费用或服务边界说明');
  }
  if (!DOUYIN_PROTECTION_PATTERN.test(description)) {
    issues.push('douyin:发布主文案缺少防护、责任或风险处理说明');
  }
  if (!DOUYIN_SCHEDULE_PATTERN.test(description)) {
    issues.push('douyin:发布主文案缺少预约、工期或现场调度说明');
  }
  if (practicalTipCount(description) < 3) {
    issues.push('douyin:发布主文案必须给出至少 3 条明确编号的实操避坑点');
  }
  if (!DOUYIN_CONCLUSION_PATTERN.test(paragraphs.at(-1) ?? '')) {
    issues.push('douyin:发布主文案最后一段必须落到可执行的选择依据或判断结论');
  }
  if (DOUYIN_ASSISTANT_FLAVOR_PATTERNS.some((pattern) => pattern.test(description))) {
    issues.push('douyin:发布主文案仍含模板钩子、助手过渡语或空泛免责声明');
  }
  if (/[？?]\s*$/u.test(description)) {
    issues.push('douyin:发布主文案不得用无明确任务的互动问句收尾');
  }
  return issues;
}

function descriptionParagraphs(value: string): readonly string[] {
  return Object.freeze(
    value
      .split(/\n+/u)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean),
  );
}

function sentenceTexts(value: string): readonly string[] {
  return Object.freeze(
    (value.match(/[^。！？!?]+[。！？!?]?/gu) ?? [])
      .map((sentence) => sentence.trim())
      .filter(Boolean),
  );
}

function sharedMeaningfulCharacters(left: string, right: string): number {
  const ignored = new Set([...'的一是在了与和及为把将可要']);
  const leftCharacters = new Set(
    [...normalize(left)].filter(
      (character) => /[\p{Script=Han}A-Za-z0-9]/u.test(character) && !ignored.has(character),
    ),
  );
  return [
    ...new Set(
      [...normalize(right)].filter(
        (character) => /[\p{Script=Han}A-Za-z0-9]/u.test(character) && !ignored.has(character),
      ),
    ),
  ].filter((character) => leftCharacters.has(character)).length;
}

function practicalTipCount(value: string): number {
  const chinese = value.match(/第[一二三四五六七八九十](?=[，、：:])/gu) ?? [];
  const arabic = value.match(/(?:^|[\s；;。])\d{1,2}[.、](?=\S)/gu) ?? [];
  return new Set([...chinese, ...arabic.map((item) => item.trim())]).size;
}

function douyinCardTexts(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value.flatMap((card) => {
      if (!record(card)) return [];
      return [card['heading'], card['body']].filter(
        (text): text is string => typeof text === 'string',
      );
    }),
  );
}

function hasNearDuplicate(values: readonly string[]): boolean {
  const grams = values.map((value) => characterBigrams(normalize(value)));
  for (let left = 0; left < grams.length; left += 1) {
    for (let right = left + 1; right < grams.length; right += 1) {
      const a = grams[left]!;
      const b = grams[right]!;
      if (a.size === 0 || b.size === 0) continue;
      let intersection = 0;
      for (const gram of a) if (b.has(gram)) intersection += 1;
      if ((2 * intersection) / (a.size + b.size) >= 0.72) return true;
    }
  }
  return false;
}

function characterBigrams(value: string): ReadonlySet<string> {
  const characters = [...value];
  const grams = new Set<string>();
  for (let index = 0; index < characters.length - 1; index += 1) {
    grams.add(`${characters[index]}${characters[index + 1]}`);
  }
  return grams;
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function countReadableCharacters(value: string): number {
  return value.replace(/[\s\p{P}\p{S}]/gu, '').length;
}

function normalize(value: string): string {
  return value.replace(/\s+/gu, '').toLocaleLowerCase('zh-CN');
}
