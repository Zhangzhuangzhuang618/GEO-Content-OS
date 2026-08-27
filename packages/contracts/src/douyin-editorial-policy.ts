export interface DouyinEditorialFinding {
  readonly code: string;
  readonly location: string;
  readonly message: string;
  readonly suggestion: string;
}

export const DOUYIN_DESCRIPTION_CAPTION_MAX_CHARACTERS = 1_000;

const DESCRIPTION_MINIMUM = 420;
const DESCRIPTION_MAXIMUM = 900;
const DESCRIPTION_PARAGRAPH_MINIMUM = 5;
const DESCRIPTION_PARAGRAPH_MAXIMUM = 8;
const PAIN_PATTERN =
  /涉及|容易|可能|常见|遇到|损伤|延误|混乱|加价|停工|风险|难点|麻烦|遗漏|不足|卡住/u;
const SOLUTION_PATTERN = /勘测|核对|记录|评估|确认|检查|清点|测量|规划/u;
const PRICE_BOUNDARY_PATTERN = /报价|费用|计费|收费|服务范围|服务边界|书面约定/u;
const PROTECTION_PATTERN = /防护|包装|加固|保障|损坏|磕碰|风险|责任|验收/u;
const SCHEDULE_PATTERN = /预约|响应|排期|工期|停工|调度|时间|进场|出场/u;
const CONCLUSION_PATTERN = /结合|对照|综合|核对|确认|选择|判断|降低|避免|减少/u;
const ASSISTANT_FLAVOR_PATTERNS = [
  /^\s*(?:先说结论|直接说结论|这次只看)/u,
  /真正(?:决定|重要|关键)[^。！？!?]{0,60}(?:不是|并非)[^。！？!?]{0,60}(?:而是|是)/u,
  /(?:^|[。！？!?\n])(?:下面(?:我们)?(?:来)?|接下来(?:我们)?)(?:看|说|介绍|分析|梳理)|总的来说|综上所述|希望(?:以上|这些).{0,16}(?:帮助|参考)/u,
  /以上(?:内容|流程|建议).{0,24}(?:仅供参考|来自公开|整理)/u,
] as const;

export function assessDouyinImageNoteEditorial(
  content: unknown,
): readonly DouyinEditorialFinding[] {
  const findings: DouyinEditorialFinding[] = [];
  const value = record(content);
  const title = stringValue(value?.['title']);
  const titleLength = [...title.trim()].length;
  if (titleLength < 6 || titleLength > 26) {
    findings.push(
      finding(
        'title_length',
        'title',
        `douyin:标题为 ${titleLength} 个字符，必须为 6–26 个字符`,
        '将标题调整为 6–26 个字符，并保留明确主题。',
      ),
    );
  }

  const meta = record(value?.['platform_meta']);
  if (
    !meta ||
    Object.keys(meta).some(
      (key) => !['cards', 'content_kind', 'description', 'topics'].includes(key),
    )
  ) {
    findings.push(
      finding(
        'platform_meta_shape',
        'platform_meta',
        'douyin:platform_meta 只能包含 content_kind、description、topics 和 cards',
        '删除抖音图文平台元数据中的未知字段。',
      ),
    );
  }
  if (meta?.['content_kind'] !== 'image_note') {
    findings.push(
      finding(
        'content_kind',
        'platform_meta.content_kind',
        'douyin:platform_meta.content_kind 必须为 image_note',
        '将抖音内容类型设置为 image_note。',
      ),
    );
  }

  const description = meta?.['description'];
  if (
    typeof description !== 'string' ||
    [...description.trim()].length < DESCRIPTION_MINIMUM ||
    [...description.trim()].length > DESCRIPTION_MAXIMUM
  ) {
    findings.push(
      finding(
        'description_length',
        'platform_meta.description',
        'douyin:platform_meta.description 必须为 420–900 个字符',
        '将发布主文案调整为 420–900 个字符。',
      ),
    );
  } else {
    findings.push(...narrativeDescriptionFindings(value, meta ?? Object.freeze({}), description));
  }

  const topics = meta?.['topics'];
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
    findings.push(
      finding(
        'topics',
        'platform_meta.topics',
        'douyin:platform_meta.topics 必须包含 3–8 个不重复的有效话题',
        '保留 3–8 个与正文直接相关且不重复的话题。',
      ),
    );
  } else if (
    typeof description === 'string' &&
    douyinDescriptionCaptionLength(description, topics) > DOUYIN_DESCRIPTION_CAPTION_MAX_CHARACTERS
  ) {
    findings.push(
      finding(
        'caption_length',
        'platform_meta',
        `douyin:发布主文案与话题合计不得超过 ${DOUYIN_DESCRIPTION_CAPTION_MAX_CHARACTERS} 个字符`,
        '缩短发布主文案或话题，使实际填写内容不超过平台上限。',
      ),
    );
  }

  const cards = meta?.['cards'];
  if (!Array.isArray(cards) || cards.length < 6 || cards.length > 9) {
    findings.push(
      finding(
        'cards_count',
        'platform_meta.cards',
        'douyin:platform_meta.cards 必须包含 6–9 张图文卡片',
        '将图文卡片数量调整为 6–9 张。',
      ),
    );
    return Object.freeze(findings);
  }

  const keys = new Set<string>();
  const validCards = cards.every((card, index) => {
    const cardValue = record(card);
    if (!cardValue) return false;
    const body = cardValue['body'];
    const cardKey = cardValue['card_key'];
    const heading = cardValue['heading'];
    const kind = cardValue['kind'];
    const headingLength = typeof heading === 'string' ? [...heading.trim()].length : 0;
    const bodyLength = typeof body === 'string' ? [...body.trim()].length : 0;
    const textLengthValid =
      kind === 'cover'
        ? headingLength >= 6 && headingLength <= 22 && bodyLength >= 12 && bodyLength <= 46
        : kind === 'summary'
          ? headingLength >= 4 && headingLength <= 16 && bodyLength >= 30 && bodyLength <= 96
          : headingLength >= 4 && headingLength <= 16 && bodyLength >= 24 && bodyLength <= 88;
    const valid =
      Object.keys(cardValue).every((key) =>
        ['body', 'card_key', 'heading', 'kind'].includes(key),
      ) &&
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
    findings.push(
      finding(
        'cards_shape',
        'platform_meta.cards',
        'douyin:图文卡片必须按封面、正文、总结排序，且 card_key 唯一、标题简短、正文适合单页扫读',
        '按封面、正文、总结顺序修正卡片，并确保标识唯一、文字适合单页扫读。',
      ),
    );
    return Object.freeze(findings);
  }

  const normalizedCards = cards.map((card) => {
    const cardValue = record(card)!;
    return `${String(cardValue['heading'])}\n${String(cardValue['body'])}`;
  });
  if (hasNearDuplicate(normalizedCards)) {
    findings.push(
      finding(
        'cards_duplicate',
        'platform_meta.cards',
        'douyin:不同卡片存在同义重复，必须让每页提供新的判断或动作',
        '删除同义重复，让每张卡片提供新的判断、步骤或风险信息。',
      ),
    );
  }
  if (
    cards.some((card) =>
      /^(?:实用提示|实用指南|要点回顾|注意事项|温馨提示|内容总结|总结)$/u.test(
        String(record(card)?.['heading']).trim(),
      ),
    )
  ) {
    findings.push(
      finding(
        'card_template_heading',
        'platform_meta.cards',
        'douyin:卡片标题仍是通用模板词，必须改为该页的具体信息',
        '将通用模板标题改成该页的具体结论或动作。',
      ),
    );
  }
  const cover = record(cards[0])!;
  const coverText = `${String(cover['heading'])}${String(cover['body'])}`;
  if (!/[？?]|怎么|如何|先看|关键|避坑|清单|步骤|判断|别急/u.test(coverText)) {
    findings.push(
      finding(
        'cover_hook',
        'platform_meta.cards.0',
        'douyin:封面缺少具体问题、收益或判断钩子',
        '在封面明确一个具体问题、收益或判断钩子。',
      ),
    );
  }
  const bodyText = cards
    .slice(1, -1)
    .map((card) => {
      const cardValue = record(card)!;
      return `${String(cardValue['heading'])}\n${String(cardValue['body'])}`;
    })
    .join('\n');
  if (!/判断|标准|条件|取决|核对|选择|是否|先看/u.test(bodyText)) {
    findings.push(
      finding(
        'card_selection',
        'platform_meta.cards',
        'douyin:正文卡片缺少可执行的选择标准或判断条件',
        '补充可执行的选择标准或判断条件。',
      ),
    );
  }
  if (!/步骤|先|再|准备|确认|检查|清点|预约|沟通|记录|核对/u.test(bodyText)) {
    findings.push(
      finding(
        'card_steps',
        'platform_meta.cards',
        'douyin:正文卡片缺少明确步骤或操作清单',
        '补充明确步骤或操作清单。',
      ),
    );
  }
  if (!/风险|避免|不要|不适合|注意|否则|边界|不能|可能|警惕/u.test(bodyText)) {
    findings.push(
      finding(
        'card_risk',
        'platform_meta.cards',
        'douyin:正文卡片缺少风险、不适用情形或事实边界',
        '补充风险、不适用情形或事实边界。',
      ),
    );
  }
  return Object.freeze(findings);
}

export function assessDouyinOwnerPromotion(
  content: unknown,
  ownerCompanyNames: readonly string[],
): readonly DouyinEditorialFinding[] {
  const owners = [...new Set(ownerCompanyNames.map((name) => name.trim()).filter(Boolean))];
  if (owners.length === 0) return Object.freeze([]);
  const value = record(content);
  const meta = record(value?.['platform_meta']);
  const description = stringValue(meta?.['description']);
  const paragraphs = descriptionParagraphs(description);
  const solutionParagraphs = paragraphs.slice(1, 3).join('\n');
  if (!owners.some((name) => solutionParagraphs.includes(name))) {
    return Object.freeze([
      finding(
        'owner_solution_mention',
        'platform_meta.description',
        `douyin:发布主文案第二或第三段必须自然提及一次当前企业名称（${owners.join('、')}），并且只能说明输入资料支持的服务`,
        '在第二或第三段自然提及一次当前企业名称，且只说明资料支持的服务。',
      ),
    ]);
  }
  const mentionCount = owners.reduce(
    (total, name) => total + description.split(name).length - 1,
    0,
  );
  return mentionCount > 2
    ? Object.freeze([
        finding(
          'owner_mention_limit',
          'platform_meta.description',
          'douyin:发布主文案中的本企业名称最多自然出现 2 次，避免重复推广',
          '将当前企业名称减少到最多 2 次。',
        ),
      ])
    : Object.freeze([]);
}

export function buildDouyinDescriptionCaption(
  description: string,
  topics: readonly string[],
): string {
  const topicText = topics.map((topic) => `#${topic.replace(/^#+/u, '')}`).join(' ');
  return `${description}\n\n${topicText}`.trim();
}

export function douyinDescriptionCaptionLength(
  description: string,
  topics: readonly string[],
): number {
  return [...buildDouyinDescriptionCaption(description, topics)].length;
}

function narrativeDescriptionFindings(
  content: Readonly<Record<string, unknown>> | null,
  meta: Readonly<Record<string, unknown>>,
  description: string,
): readonly DouyinEditorialFinding[] {
  const findings: DouyinEditorialFinding[] = [];
  const paragraphs = descriptionParagraphs(description);
  if (
    paragraphs.length < DESCRIPTION_PARAGRAPH_MINIMUM ||
    paragraphs.length > DESCRIPTION_PARAGRAPH_MAXIMUM
  ) {
    findings.push(
      finding(
        'description_paragraphs',
        'platform_meta.description',
        'douyin:发布主文案必须使用 5–8 个长短有变化的自然段',
        '将发布主文案整理为 5–8 个长短有变化的自然段。',
      ),
    );
  }

  const openingSentences = sentenceTexts(paragraphs[0] ?? '');
  if (
    openingSentences.length !== 2 ||
    [...(openingSentences[0] ?? '')].length > 48 ||
    sharedMeaningfulCharacters(openingSentences[0] ?? '', stringValue(content?.['title'])) < 2
  ) {
    findings.push(
      finding(
        'description_opening',
        'platform_meta.description',
        'douyin:发布主文案第一段必须用第一句点题、第二句交代场景痛点',
        '第一段只写两句：第一句点题，第二句交代具体场景痛点。',
      ),
    );
  } else if (!PAIN_PATTERN.test(openingSentences[1] ?? '')) {
    findings.push(
      finding(
        'description_pain',
        'platform_meta.description',
        'douyin:发布主文案第二句话缺少具体对象、现实问题或后果',
        '在第二句话补充具体对象、现实问题或后果。',
      ),
    );
  }

  const normalizedDescription = normalize(description);
  const duplicatedSource = [
    stringValue(content?.['summary']),
    ...contentBlockTexts(content?.['blocks']),
    ...cardTexts(meta['cards']),
  ].some((source) => normalize(source) === normalizedDescription);
  if (duplicatedSource) {
    findings.push(
      finding(
        'description_duplicate',
        'platform_meta.description',
        'douyin:发布主文案不得直接复制摘要、正文块或单张卡片',
        '重新组织发布主文案，不要直接复制摘要、正文块或单张卡片。',
      ),
    );
  }

  for (const [code, pattern, message, suggestion] of [
    [
      'description_solution',
      SOLUTION_PATTERN,
      'douyin:发布主文案缺少可执行的现场核对或方案动作',
      '补充可执行的现场核对或方案动作。',
    ],
    [
      'description_price_boundary',
      PRICE_BOUNDARY_PATTERN,
      'douyin:发布主文案缺少报价、费用或服务边界说明',
      '补充报价、费用或服务边界说明。',
    ],
    [
      'description_protection',
      PROTECTION_PATTERN,
      'douyin:发布主文案缺少防护、责任或风险处理说明',
      '补充防护、责任或风险处理说明。',
    ],
    [
      'description_schedule',
      SCHEDULE_PATTERN,
      'douyin:发布主文案缺少预约、工期或现场调度说明',
      '补充预约、工期或现场调度说明。',
    ],
  ] as const) {
    if (!pattern.test(description)) {
      findings.push(finding(code, 'platform_meta.description', message, suggestion));
    }
  }
  if (practicalTipCount(description) < 3) {
    findings.push(
      finding(
        'description_tips',
        'platform_meta.description',
        'douyin:发布主文案必须给出至少 3 条明确编号的实操避坑点',
        '补充至少 3 条明确编号的实操避坑点。',
      ),
    );
  }
  if (!CONCLUSION_PATTERN.test(paragraphs.at(-1) ?? '')) {
    findings.push(
      finding(
        'description_conclusion',
        'platform_meta.description',
        'douyin:发布主文案最后一段必须落到可执行的选择依据或判断结论',
        '最后一段给出可执行的选择依据或判断结论。',
      ),
    );
  }
  if (ASSISTANT_FLAVOR_PATTERNS.some((pattern) => pattern.test(description))) {
    findings.push(
      finding(
        'description_assistant_flavor',
        'platform_meta.description',
        'douyin:发布主文案仍含模板钩子、助手过渡语或空泛免责声明',
        '删除模板钩子、助手过渡语和空泛免责声明。',
      ),
    );
  }
  if (/[？?]\s*$/u.test(description)) {
    findings.push(
      finding(
        'description_question_ending',
        'platform_meta.description',
        'douyin:发布主文案不得用无明确任务的互动问句收尾',
        '改为明确的行动建议或判断结论收尾。',
      ),
    );
  }
  return findings;
}

function finding(
  code: string,
  location: string,
  message: string,
  suggestion: string,
): DouyinEditorialFinding {
  return Object.freeze({ code, location, message, suggestion });
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

function contentBlockTexts(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value.flatMap((block) => {
      const blockValue = record(block);
      return typeof blockValue?.['text'] === 'string' ? [blockValue['text']] : [];
    }),
  );
}

function cardTexts(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value.flatMap((card) => {
      const cardValue = record(card);
      if (!cardValue) return [];
      return [cardValue['heading'], cardValue['body']].filter(
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

function normalize(value: string): string {
  return value.replace(/\s+/gu, '').toLocaleLowerCase('zh-CN');
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}
