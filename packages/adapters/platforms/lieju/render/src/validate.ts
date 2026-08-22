import {
  findLiejuForbiddenContactDetails,
  findLiejuProhibitedPromotionalTerms,
} from '@geo-content-os/contracts';

import { LIEJU_RENDER_RULES_V1 } from './rules.js';
import { LiejuRenderInputSchema } from './schema.js';
import type {
  LiejuRenderInput,
  LiejuValidationCode,
  LiejuValidationIssue,
  LiejuValidationResult,
} from './types.js';

export function validateLiejuContent(input: unknown): LiejuValidationResult {
  const parsed = LiejuRenderInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) =>
        blocker('PAYLOAD_SCHEMA_INVALID', issue.message, pathOf(issue.path)),
      ),
      ok: false,
    };
  }
  const value = parsed.data as LiejuRenderInput;
  const issues: LiejuValidationIssue[] = [];
  const titleLength = [...value.content.title].length;
  if (
    titleLength < LIEJU_RENDER_RULES_V1.title.minimumCharacters ||
    titleLength > LIEJU_RENDER_RULES_V1.title.maximumCharacters
  ) {
    issues.push(blocker('TITLE_LENGTH_OUT_OF_RANGE', '标题必须为 5-30 字。', 'content.title'));
  }
  const bodyText = value.content.blocks.map((block) => block.text.trim()).join('\n\n');
  const bodyLength = [...bodyText].length;
  if (
    bodyLength < LIEJU_RENDER_RULES_V1.body.minimumCharacters ||
    bodyLength > LIEJU_RENDER_RULES_V1.body.maximumCharacters
  ) {
    issues.push(blocker('BODY_LENGTH_OUT_OF_RANGE', '描述必须为 600-8000 字。', 'content.blocks'));
  }
  const publishText = `${value.content.title}\n${bodyText}`;
  if (findLiejuForbiddenContactDetails(publishText).length > 0) {
    issues.push(blocker('CONTACT_INFO_FORBIDDEN', '标题和描述不得包含联系方式或网址。', 'content'));
  }
  if (findLiejuProhibitedPromotionalTerms(publishText).length > 0) {
    issues.push(blocker('PROHIBITED_TERM', '内容包含列举网禁止或高风险宣传词。', 'content'));
  }
  const bodySegments = value.content.blocks.filter(
    (block) => block.block_type !== 'heading' && block.block_type !== 'media' && block.text.trim(),
  );
  if (bodySegments.length < LIEJU_RENDER_RULES_V1.requiredBodySegments) {
    issues.push(
      blocker(
        'SEGMENTATION_REQUIRED',
        `正文至少需要 ${LIEJU_RENDER_RULES_V1.requiredBodySegments} 个非空内容段。`,
        'content.blocks',
      ),
    );
  }
  return issues.length === 0
    ? { issues: [], ok: true, value }
    : { issues: Object.freeze(issues), ok: false };
}

function blocker(code: LiejuValidationCode, message: string, path: string): LiejuValidationIssue {
  return { code, message, path, severity: 'blocker' };
}

function pathOf(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '$' : path.map(String).join('.');
}
