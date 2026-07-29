import { ALLOWED_COMPANY_NAME, findDisallowedCompanyNames } from '@geo-content-os/contracts';

import { OfficialSiteRenderInputSchema } from './schema.js';
import { OFFICIAL_SITE_RENDER_RULES_V1 } from './rules.js';
import type {
  OfficialSiteRenderInput,
  OfficialSiteValidationCode,
  OfficialSiteValidationIssue,
  OfficialSiteValidationResult,
} from './types.js';

export function validateOfficialSiteContent(input: unknown): OfficialSiteValidationResult {
  const parsed = OfficialSiteRenderInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) =>
        blocker('PAYLOAD_SCHEMA_INVALID', issue.message, pathOf(issue.path)),
      ),
      ok: false,
    };
  }

  const value = parsed.data as OfficialSiteRenderInput;
  const issues: OfficialSiteValidationIssue[] = [];
  const titleLength = characterLength(value.content.title);
  if (
    titleLength < OFFICIAL_SITE_RENDER_RULES_V1.title.minimumCharacters ||
    titleLength > OFFICIAL_SITE_RENDER_RULES_V1.title.maximumCharacters
  ) {
    issues.push(
      blocker(
        'TITLE_LENGTH_OUT_OF_RANGE',
        `标题必须为 ${OFFICIAL_SITE_RENDER_RULES_V1.title.minimumCharacters}-${OFFICIAL_SITE_RENDER_RULES_V1.title.maximumCharacters} 字。`,
        'content.title',
      ),
    );
  }

  const bodyLength = value.content.blocks
    .filter((block) => block.block_type !== 'heading' && block.block_type !== 'media')
    .reduce((total, block) => total + effectiveCharacterLength(block.text), 0);
  if (
    bodyLength < OFFICIAL_SITE_RENDER_RULES_V1.body.minimumCharacters ||
    bodyLength > OFFICIAL_SITE_RENDER_RULES_V1.body.maximumCharacters
  ) {
    issues.push(
      blocker(
        'BODY_LENGTH_OUT_OF_RANGE',
        `正文必须为 ${OFFICIAL_SITE_RENDER_RULES_V1.body.minimumCharacters}-${OFFICIAL_SITE_RENDER_RULES_V1.body.maximumCharacters} 字。`,
        'content.blocks',
      ),
    );
  }

  if (
    !value.content.blocks.some(
      (block) => block.block_type === 'heading' && block.text.trim().length > 0,
    )
  ) {
    issues.push(blocker('H2_REQUIRED', '正文至少需要一个 H2 标题块。', 'content.blocks'));
  }

  const firstBodyBlock = value.content.blocks.find(
    (block) => block.block_type !== 'heading' && block.block_type !== 'media',
  );
  if (firstBodyBlock?.block_type !== 'paragraph' || firstBodyBlock.text.trim().length === 0) {
    issues.push(
      blocker(
        'FIRST_PARAGRAPH_REQUIRED',
        '首个正文块必须是直接给出定义的非空段落。',
        'content.blocks',
      ),
    );
  }

  if (value.content.platform_meta.faq.length === 0) {
    issues.push(blocker('FAQ_REQUIRED', '官网内容必须包含 FAQ。', 'content.platform_meta.faq'));
  }

  if (
    typeof value.content.platform_meta.schema_org['@context'] !== 'string' ||
    typeof value.content.platform_meta.schema_org['@type'] !== 'string'
  ) {
    issues.push(
      blocker(
        'SCHEMA_ORG_REQUIRED',
        'schema_org 必须包含 @context 和 @type。',
        'content.platform_meta.schema_org',
      ),
    );
  }

  const disallowedCompanyNames = findDisallowedCompanyNames(JSON.stringify(value));
  if (disallowedCompanyNames.length > 0) {
    issues.push(
      blocker(
        'OTHER_COMPANY_NAME_FORBIDDEN',
        `官网内容不得出现其他企业或品牌名称：${disallowedCompanyNames.join('、')}。请改为“某公司”等匿名表述；只允许出现“${ALLOWED_COMPANY_NAME}”。`,
        'content',
      ),
    );
  }

  // citation_map retains internal audit evidence; citations contains only links safe for publication.
  // Documentary evidence without a public URL remains valid and is intentionally omitted by render.
  return issues.length === 0
    ? { issues: [], ok: true, value }
    : { issues: Object.freeze(issues), ok: false };
}

function blocker(
  code: OfficialSiteValidationCode,
  message: string,
  path: string,
): OfficialSiteValidationIssue {
  return { code, message, path, severity: 'blocker' };
}

function characterLength(value: string): number {
  return [...value].length;
}

function effectiveCharacterLength(value: string): number {
  return value.replace(/[\s\p{P}\p{S}]/gu, '').length;
}

function pathOf(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '$' : path.map(String).join('.');
}
