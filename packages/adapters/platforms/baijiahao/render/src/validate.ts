import { BAIJIAHAO_RENDER_RULES_V1 } from './rules.js';
import { BaijiahaoRenderInputSchema } from './schema.js';
import type {
  BaijiahaoRenderInput,
  BaijiahaoValidationCode,
  BaijiahaoValidationIssue,
  BaijiahaoValidationResult,
} from './types.js';

const ABSOLUTE_DATE_PATTERN =
  /(?:19|20)\d{2}(?:年(?:\d{1,2}月(?:\d{1,2}日)?)?|[-/.]\d{1,2}(?:[-/.]\d{1,2})?)/u;

export function validateBaijiahaoContent(input: unknown): BaijiahaoValidationResult {
  const parsed = BaijiahaoRenderInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) =>
        blocker('PAYLOAD_SCHEMA_INVALID', issue.message, pathOf(issue.path)),
      ),
      ok: false,
    };
  }

  const value = parsed.data as BaijiahaoRenderInput;
  const issues: BaijiahaoValidationIssue[] = [];
  const titleLength = characterLength(value.content.title);
  if (
    titleLength < BAIJIAHAO_RENDER_RULES_V1.title.minimumCharacters ||
    titleLength > BAIJIAHAO_RENDER_RULES_V1.title.maximumCharacters
  ) {
    issues.push(
      blocker(
        'TITLE_LENGTH_OUT_OF_RANGE',
        `标题必须为 ${BAIJIAHAO_RENDER_RULES_V1.title.minimumCharacters}-${BAIJIAHAO_RENDER_RULES_V1.title.maximumCharacters} 字。`,
        'content.title',
      ),
    );
  }

  const abstractLength = characterLength(value.content.platform_meta.abstract.trim());
  if (
    abstractLength < BAIJIAHAO_RENDER_RULES_V1.abstract.minimumCharacters ||
    abstractLength > BAIJIAHAO_RENDER_RULES_V1.abstract.maximumCharacters
  ) {
    issues.push(
      blocker(
        'ABSTRACT_LENGTH_OUT_OF_RANGE',
        `摘要必须为 ${BAIJIAHAO_RENDER_RULES_V1.abstract.minimumCharacters}-${BAIJIAHAO_RENDER_RULES_V1.abstract.maximumCharacters} 字。`,
        'content.platform_meta.abstract',
      ),
    );
  }

  const tagCount = value.content.platform_meta.tags.length;
  if (
    tagCount < BAIJIAHAO_RENDER_RULES_V1.tags.minimumItems ||
    tagCount > BAIJIAHAO_RENDER_RULES_V1.tags.maximumItems
  ) {
    issues.push(
      blocker(
        'TAG_COUNT_OUT_OF_RANGE',
        `标签数量必须为 ${BAIJIAHAO_RENDER_RULES_V1.tags.minimumItems}-${BAIJIAHAO_RENDER_RULES_V1.tags.maximumItems} 个。`,
        'content.platform_meta.tags',
      ),
    );
  }

  const bodySegments = value.content.blocks.filter(
    (block) => block.block_type !== 'heading' && block.block_type !== 'media' && block.text.trim(),
  );
  if (bodySegments.length < BAIJIAHAO_RENDER_RULES_V1.requiredBodySegments) {
    issues.push(
      blocker(
        'SEGMENTATION_REQUIRED',
        `正文至少需要 ${BAIJIAHAO_RENDER_RULES_V1.requiredBodySegments} 个非空内容段。`,
        'content.blocks',
      ),
    );
  }

  const ambiguousPath = findAmbiguousTimePath(value);
  if (ambiguousPath) {
    issues.push(
      blocker(
        'TIME_REFERENCE_AMBIGUOUS',
        '相对时间表述必须在同一字段或内容块中注明明确年份或日期。',
        ambiguousPath,
      ),
    );
  }

  const availableCitationIds = new Set(value.citations.map((citation) => citation.citation_id));
  const missingCitation = value.content.citation_map
    .flatMap((claim) => claim.citation_ids)
    .find((citationId) => !availableCitationIds.has(citationId));
  if (missingCitation) {
    issues.push(
      blocker(
        'CITATION_LINK_MISSING',
        '引用 ID 必须映射到可输出的 HTTP(S) 引用链接。',
        'citations',
      ),
    );
  }

  return issues.length === 0
    ? { issues: [], ok: true, value }
    : { issues: Object.freeze(issues), ok: false };
}

function findAmbiguousTimePath(value: BaijiahaoRenderInput): string | null {
  const segments = [
    { path: 'content.title', text: value.content.title },
    { path: 'content.platform_meta.abstract', text: value.content.platform_meta.abstract },
    ...value.content.blocks.map((block, index) => ({
      path: `content.blocks.${index}.text`,
      text: block.text,
    })),
  ];
  for (const segment of segments) {
    const hasRelativeMarker = BAIJIAHAO_RENDER_RULES_V1.ambiguousTimeMarkers.some((marker) =>
      segment.text.includes(marker),
    );
    if (hasRelativeMarker && !ABSOLUTE_DATE_PATTERN.test(segment.text)) return segment.path;
  }
  return null;
}

function blocker(
  code: BaijiahaoValidationCode,
  message: string,
  path: string,
): BaijiahaoValidationIssue {
  return { code, message, path, severity: 'blocker' };
}

function characterLength(value: string): number {
  return [...value].length;
}

function pathOf(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '$' : path.map(String).join('.');
}
