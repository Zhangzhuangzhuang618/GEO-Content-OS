import { WECHAT_MP_RENDER_RULES_V1 } from './rules.js';
import { WechatMpRenderInputSchema } from './schema.js';
import type {
  WechatMpRenderInput,
  WechatMpValidationCode,
  WechatMpValidationIssue,
  WechatMpValidationResult,
} from './types.js';

export function validateWechatMpContent(input: unknown): WechatMpValidationResult {
  const parsed = WechatMpRenderInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) =>
        blocker('PAYLOAD_SCHEMA_INVALID', issue.message, pathOf(issue.path)),
      ),
      ok: false,
    };
  }

  const value = parsed.data as WechatMpRenderInput;
  const issues: WechatMpValidationIssue[] = [];
  const titleLength = [...value.content.title].length;
  if (
    titleLength < WECHAT_MP_RENDER_RULES_V1.title.minimumCharacters ||
    titleLength > WECHAT_MP_RENDER_RULES_V1.title.maximumCharacters
  ) {
    issues.push(
      blocker(
        'TITLE_LENGTH_OUT_OF_RANGE',
        `标题必须为 ${WECHAT_MP_RENDER_RULES_V1.title.minimumCharacters}-${WECHAT_MP_RENDER_RULES_V1.title.maximumCharacters} 字。`,
        'content.title',
      ),
    );
  }
  if (!value.content.platform_meta.digest.trim()) {
    issues.push(blocker('DIGEST_REQUIRED', '必须提供非空摘要。', 'content.platform_meta.digest'));
  }
  const firstBlock = value.content.blocks[0];
  if (firstBlock?.block_type !== 'paragraph' || !firstBlock.text.trim()) {
    issues.push(blocker('LEAD_REQUIRED', '正文首块必须是非空导语段。', 'content.blocks.0'));
  }
  if (value.internal_links.length === 0) {
    issues.push(blocker('INTERNAL_LINK_REQUIRED', '必须提供至少一个结构化内链。', 'internal_links'));
  }
  if (!resolveWechatMpCta(value.content)) {
    issues.push(blocker('CTA_REQUIRED', '必须提供非空 CTA。', 'content.cta'));
  }
  value.content.blocks.forEach((block, index) => {
    if (
      block.block_type === 'paragraph' &&
      [...block.text.trim()].length > WECHAT_MP_RENDER_RULES_V1.paragraphMaximumCharacters
    ) {
      issues.push(
        blocker(
          'PARAGRAPH_TOO_LONG',
          `普通段落不得超过 ${WECHAT_MP_RENDER_RULES_V1.paragraphMaximumCharacters} 字。`,
          `content.blocks.${index}.text`,
        ),
      );
    }
  });
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

export function resolveWechatMpCta(content: WechatMpRenderInput['content']): string {
  const explicit = content.cta?.trim();
  if (explicit) return explicit;
  return content.blocks.find((block) => block.block_type === 'cta')?.text.trim() ?? '';
}

function blocker(
  code: WechatMpValidationCode,
  message: string,
  path: string,
): WechatMpValidationIssue {
  return { code, message, path, severity: 'blocker' };
}

function pathOf(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '$' : path.map(String).join('.');
}
