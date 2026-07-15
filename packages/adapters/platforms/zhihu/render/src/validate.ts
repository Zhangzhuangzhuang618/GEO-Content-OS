import { ZHIHU_RENDER_RULES_V1 } from './rules.js';
import { ZhihuRenderInputSchema } from './schema.js';
import type {
  ZhihuRenderInput,
  ZhihuValidationCode,
  ZhihuValidationIssue,
  ZhihuValidationResult,
} from './types.js';

export function validateZhihuContent(input: unknown): ZhihuValidationResult {
  const parsed = ZhihuRenderInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) =>
        blocker('PAYLOAD_SCHEMA_INVALID', issue.message, pathOf(issue.path)),
      ),
      ok: false,
    };
  }

  const value = parsed.data as ZhihuRenderInput;
  const issues: ZhihuValidationIssue[] = [];
  const firstBlock = value.content.blocks[0];
  if (
    firstBlock?.block_type !== 'paragraph' ||
    firstBlock.text.trim().length === 0 ||
    /[?？]\s*$/u.test(firstBlock.text)
  ) {
    issues.push(
      blocker(
        'DIRECT_ANSWER_REQUIRED',
        '正文首段必须是非空陈述段，直接回答问题，不能以问句开场。',
        'content.blocks.0',
      ),
    );
  }

  const bodyText = value.content.blocks.map((block) => block.text).join('\n');
  if (!ZHIHU_RENDER_RULES_V1.boundaryMarkers.some((marker) => bodyText.includes(marker))) {
    issues.push(
      blocker(
        'BOUNDARY_OR_COUNTEREXAMPLE_REQUIRED',
        '正文必须明确给出边界、限制、例外或反例。',
        'content.blocks',
      ),
    );
  }

  const marketingText = [
    value.content.title,
    value.content.summary,
    ...value.content.blocks.map((block) => block.text),
    value.content.cta ?? '',
  ].join('\n');
  if (ZHIHU_RENDER_RULES_V1.marketingMarkers.some((marker) => marketingText.includes(marker))) {
    issues.push(blocker('MARKETING_TONE_FORBIDDEN', '内容包含禁止的营销化绝对表述。', 'content'));
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

  return issues.length === 0
    ? { issues: [], ok: true, value }
    : { issues: Object.freeze(issues), ok: false };
}

function blocker(code: ZhihuValidationCode, message: string, path: string): ZhihuValidationIssue {
  return { code, message, path, severity: 'blocker' };
}

function pathOf(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '$' : path.map(String).join('.');
}
