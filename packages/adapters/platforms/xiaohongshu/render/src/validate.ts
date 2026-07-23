import { XIAOHONGSHU_RENDER_RULES_V1 } from './rules.js';
import { XiaohongshuRenderInputSchema } from './schema.js';
import type {
  XiaohongshuRenderInput,
  XiaohongshuValidationCode,
  XiaohongshuValidationIssue,
  XiaohongshuValidationResult,
} from './types.js';

export function validateXiaohongshuContent(input: unknown): XiaohongshuValidationResult {
  const parsed = XiaohongshuRenderInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) =>
        blocker('PAYLOAD_SCHEMA_INVALID', issue.message, pathOf(issue.path)),
      ),
      ok: false,
    };
  }
  const value = parsed.data as XiaohongshuRenderInput;
  const issues: XiaohongshuValidationIssue[] = [];
  const titleLength = [...value.content.title].length;
  if (
    titleLength < XIAOHONGSHU_RENDER_RULES_V1.title.minimumCharacters ||
    titleLength > XIAOHONGSHU_RENDER_RULES_V1.title.maximumCharacters
  ) {
    issues.push(
      blocker(
        'TITLE_LENGTH_OUT_OF_RANGE',
        `标题必须为 ${XIAOHONGSHU_RENDER_RULES_V1.title.minimumCharacters}-${XIAOHONGSHU_RENDER_RULES_V1.title.maximumCharacters} 字。`,
        'content.title',
      ),
    );
  }
  if (!value.content.blocks.some((block) => block.block_type === 'list' && block.text.trim())) {
    issues.push(
      blocker('LIST_BLOCK_REQUIRED', '正文必须包含至少一个非空清单块。', 'content.blocks'),
    );
  }
  value.content.blocks.forEach((block, index) => {
    if (
      block.block_type === 'paragraph' &&
      [...block.text.trim()].length > XIAOHONGSHU_RENDER_RULES_V1.paragraphMaximumCharacters
    ) {
      issues.push(
        blocker(
          'PARAGRAPH_TOO_LONG',
          `普通段落不得超过 ${XIAOHONGSHU_RENDER_RULES_V1.paragraphMaximumCharacters} 字。`,
          `content.blocks.${index}.text`,
        ),
      );
    }
  });
  if (value.content.platform_meta.topics.length === 0) {
    issues.push(
      blocker('TOPIC_REQUIRED', '必须提供至少一个话题。', 'content.platform_meta.topics'),
    );
  }
  const allText = [
    value.content.title,
    value.content.summary,
    ...value.content.blocks.map((block) => block.text),
    value.content.cta ?? '',
  ].join('\n');
  if (
    XIAOHONGSHU_RENDER_RULES_V1.experienceClaimMarkers.some((marker) => allText.includes(marker))
  ) {
    issues.push(
      blocker(
        'UNVERIFIED_EXPERIENCE_CLAIM',
        '内容包含无法由系统验证的第一人称体验表述。',
        'content',
      ),
    );
  }
  const referenced = new Set(value.content.citation_map.flatMap((claim) => claim.citation_ids));
  const available = new Set(value.citations.map((citation) => citation.citation_id));
  if ([...referenced].some((citationId) => !available.has(citationId))) {
    issues.push(
      blocker('CITATION_LINK_MISSING', '引用 ID 必须映射到可输出的 HTTP(S) 链接。', 'citations'),
    );
  }
  return issues.length === 0
    ? { issues: [], ok: true, value }
    : { issues: Object.freeze(issues), ok: false };
}

function blocker(
  code: XiaohongshuValidationCode,
  message: string,
  path: string,
): XiaohongshuValidationIssue {
  return { code, message, path, severity: 'blocker' };
}

function pathOf(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '$' : path.map(String).join('.');
}
