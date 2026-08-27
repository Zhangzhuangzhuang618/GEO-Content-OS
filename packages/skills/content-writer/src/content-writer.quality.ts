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
  if (titleLength < 2 || titleLength > 30) {
    issues.push(`douyin:标题为 ${titleLength} 个字符，必须为 2–30 个字符`);
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
    description.trim().length === 0 ||
    [...description.trim()].length > 1_000
  ) {
    issues.push('douyin:platform_meta.description 必须为 1–1000 个字符');
  }
  const topics = meta['topics'];
  if (
    !Array.isArray(topics) ||
    topics.length < 1 ||
    topics.length > 20 ||
    topics.some(
      (topic) =>
        typeof topic !== 'string' || topic.trim().length === 0 || [...topic.trim()].length > 40,
    ) ||
    new Set(topics.map((topic) => (typeof topic === 'string' ? topic.trim() : String(topic))))
      .size !== topics.length
  ) {
    issues.push('douyin:platform_meta.topics 必须包含 1–20 个不重复的有效话题');
  }

  const cards = meta['cards'];
  if (!Array.isArray(cards) || cards.length < 5 || cards.length > 10) {
    issues.push('douyin:platform_meta.cards 必须包含 5–10 张图文卡片');
    return issues;
  }
  const keys = new Set<string>();
  const validCards = cards.every((card, index) => {
    if (!record(card)) return false;
    const body = card['body'];
    const cardKey = card['card_key'];
    const heading = card['heading'];
    const kind = card['kind'];
    const valid =
      Object.keys(card).every((key) => ['body', 'card_key', 'heading', 'kind'].includes(key)) &&
      typeof body === 'string' &&
      body.trim().length > 0 &&
      [...body.trim()].length <= 240 &&
      typeof cardKey === 'string' &&
      /^[a-z0-9_-]{1,80}$/u.test(cardKey) &&
      !keys.has(cardKey) &&
      typeof heading === 'string' &&
      heading.trim().length > 0 &&
      [...heading.trim()].length <= 36 &&
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
    issues.push('douyin:图文卡片必须按封面、正文、总结排序，且 card_key 唯一、标题和正文长度有效');
  }
  return issues;
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
