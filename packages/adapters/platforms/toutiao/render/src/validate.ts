import { TOUTIAO_RENDER_RULES_V1 } from './rules.js';
import { ToutiaoRenderInputSchema } from './schema.js';
import type {
  ToutiaoRenderInput,
  ToutiaoValidationCode,
  ToutiaoValidationIssue,
  ToutiaoValidationResult,
} from './types.js';

export function validateToutiaoContent(input: unknown): ToutiaoValidationResult {
  const parsed = ToutiaoRenderInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) =>
        blocker('PAYLOAD_SCHEMA_INVALID', issue.message, pathOf(issue.path)),
      ),
      ok: false,
    };
  }

  const value = parsed.data as ToutiaoRenderInput;
  const issues: ToutiaoValidationIssue[] = [];
  const titleLength = characterLength(value.content.title);
  if (
    titleLength < TOUTIAO_RENDER_RULES_V1.title.minimumCharacters ||
    titleLength > TOUTIAO_RENDER_RULES_V1.title.maximumCharacters
  ) {
    issues.push(
      blocker(
        'TITLE_LENGTH_OUT_OF_RANGE',
        `标题必须为 ${TOUTIAO_RENDER_RULES_V1.title.minimumCharacters}-${TOUTIAO_RENDER_RULES_V1.title.maximumCharacters} 字。`,
        'content.title',
      ),
    );
  }

  const leadLength = characterLength(value.content.platform_meta.lead.trim());
  if (
    leadLength < TOUTIAO_RENDER_RULES_V1.lead.minimumCharacters ||
    leadLength > TOUTIAO_RENDER_RULES_V1.lead.maximumCharacters
  ) {
    issues.push(
      blocker(
        'LEAD_LENGTH_OUT_OF_RANGE',
        `导语必须为 ${TOUTIAO_RENDER_RULES_V1.lead.minimumCharacters}-${TOUTIAO_RENDER_RULES_V1.lead.maximumCharacters} 字。`,
        'content.platform_meta.lead',
      ),
    );
  }

  if (
    TOUTIAO_RENDER_RULES_V1.clickbaitTitleMarkers.some((marker) =>
      value.content.title.includes(marker),
    )
  ) {
    issues.push(blocker('CLICKBAIT_TITLE', '标题包含禁止的标题党表述。', 'content.title'));
  }

  if (!hasQuestionAnswerStructure(value)) {
    issues.push(
      blocker(
        'QUESTION_ANSWER_REQUIRED',
        '正文必须包含问句，以及位于问句之后的非空回答段。',
        'content.blocks',
      ),
    );
  }

  const referencedCitationIds = new Set(
    value.content.citation_map.flatMap((claim) => claim.citation_ids),
  );
  const availableCitationIds = new Set(value.citations.map((citation) => citation.citation_id));
  if ([...referencedCitationIds].some((citationId) => !availableCitationIds.has(citationId))) {
    issues.push(
      blocker(
        'CITATION_LINK_MISSING',
        '引用 ID 必须映射到可输出的 HTTP(S) 引用链接。',
        'citations',
      ),
    );
  }

  if (containsTimeSensitiveClaim(value) && !hasSourcedTimeSensitiveClaim(value)) {
    issues.push(
      blocker(
        'TIME_SENSITIVE_CITATION_REQUIRED',
        '包含时效表述的内容必须提供可输出的引用来源。',
        'content.citation_map',
      ),
    );
  }

  return issues.length === 0
    ? { issues: [], ok: true, value }
    : { issues: Object.freeze(issues), ok: false };
}

function hasQuestionAnswerStructure(value: ToutiaoRenderInput): boolean {
  const questionIndex = value.content.blocks.findIndex(
    (block) => block.text.includes('？') || block.text.includes('?'),
  );
  if (questionIndex < 0) return false;
  return value.content.blocks
    .slice(questionIndex + 1)
    .some(
      (block) =>
        ['paragraph', 'list', 'quote'].includes(block.block_type) && block.text.trim().length > 0,
    );
}

function containsTimeSensitiveClaim(value: ToutiaoRenderInput): boolean {
  const text = [
    value.content.title,
    value.content.platform_meta.lead,
    ...value.content.blocks.map((block) => block.text),
  ].join('\n');
  return TOUTIAO_RENDER_RULES_V1.timeSensitiveMarkers.some((marker) => text.includes(marker));
}

function hasSourcedTimeSensitiveClaim(value: ToutiaoRenderInput): boolean {
  return value.content.citation_map.some(
    (claim) =>
      claim.citation_ids.length > 0 &&
      TOUTIAO_RENDER_RULES_V1.timeSensitiveMarkers.some((marker) =>
        claim.claim_text.includes(marker),
      ),
  );
}

function blocker(
  code: ToutiaoValidationCode,
  message: string,
  path: string,
): ToutiaoValidationIssue {
  return { code, message, path, severity: 'blocker' };
}

function characterLength(value: string): number {
  return [...value].length;
}

function pathOf(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '$' : path.map(String).join('.');
}
