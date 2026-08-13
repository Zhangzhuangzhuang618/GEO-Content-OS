import { SOHU_RENDER_RULES_V1 } from './rules.js';
import { SohuRenderInputSchema } from './schema.js';
import type {
  SohuRenderInput,
  SohuValidationCode,
  SohuValidationIssue,
  SohuValidationResult,
} from './types.js';

export function validateSohuContent(input: unknown): SohuValidationResult {
  const parsed = SohuRenderInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) =>
        blocker('PAYLOAD_SCHEMA_INVALID', issue.message, pathOf(issue.path)),
      ),
      ok: false,
    };
  }
  const value = parsed.data as SohuRenderInput;
  const issues: SohuValidationIssue[] = [];
  const titleLength = [...value.content.title].length;
  if (
    titleLength < SOHU_RENDER_RULES_V1.title.minimumCharacters ||
    titleLength > SOHU_RENDER_RULES_V1.title.maximumCharacters
  ) {
    issues.push(blocker('TITLE_LENGTH_OUT_OF_RANGE', '标题必须为 5-72 字。', 'content.title'));
  }
  const abstractLength = [...value.content.platform_meta.abstract.trim()].length;
  if (
    abstractLength < SOHU_RENDER_RULES_V1.abstract.minimumCharacters ||
    abstractLength > SOHU_RENDER_RULES_V1.abstract.maximumCharacters
  ) {
    issues.push(
      blocker(
        'ABSTRACT_LENGTH_OUT_OF_RANGE',
        '摘要必须为 1-120 字。',
        'content.platform_meta.abstract',
      ),
    );
  }
  const bodySegments = value.content.blocks.filter(
    (block) => block.block_type !== 'heading' && block.block_type !== 'media' && block.text.trim(),
  );
  if (bodySegments.length < SOHU_RENDER_RULES_V1.requiredBodySegments) {
    issues.push(
      blocker(
        'SEGMENTATION_REQUIRED',
        `正文至少需要 ${SOHU_RENDER_RULES_V1.requiredBodySegments} 个非空内容段。`,
        'content.blocks',
      ),
    );
  }
  return issues.length === 0
    ? { issues: [], ok: true, value }
    : { issues: Object.freeze(issues), ok: false };
}

function blocker(code: SohuValidationCode, message: string, path: string): SohuValidationIssue {
  return { code, message, path, severity: 'blocker' };
}

function pathOf(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '$' : path.map(String).join('.');
}
