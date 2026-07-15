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
    .reduce((total, block) => total + characterLength(block.text.trim()), 0);
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

  const availableCitationIds = new Set(value.citations.map((citation) => citation.citation_id));
  const referencedCitationIds = new Set(
    value.content.citation_map.flatMap((claim) => claim.citation_ids),
  );
  if (
    referencedCitationIds.size === 0 ||
    [...referencedCitationIds].some((citationId) => !availableCitationIds.has(citationId))
  ) {
    issues.push(
      blocker(
        'CITATION_LINK_MISSING',
        '每个引用 ID 都必须映射到可输出的 HTTP(S) 引用链接。',
        'citations',
      ),
    );
  }

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

function pathOf(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '$' : path.map(String).join('.');
}
