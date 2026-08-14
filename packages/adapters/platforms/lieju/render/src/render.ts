import { LiejuPayloadSchema } from './schema.js';
import {
  LIEJU_PAYLOAD_SCHEMA_VERSION,
  LIEJU_PLATFORM_CODE,
  LIEJU_RENDER_RULE_VERSION,
  type LiejuContent,
  type LiejuPayload,
  type LiejuRenderResult,
} from './types.js';
import { validateLiejuContent } from './validate.js';

export function renderLieju(input: unknown): LiejuRenderResult {
  const validation = validateLiejuContent(input);
  if (!validation.ok) return validation;
  const content = validation.value.content;
  const payload: LiejuPayload = {
    body_text: renderText(content),
    citation_links: Object.freeze([]),
    content_type: content.platform_meta.content_type,
    cover_asset_id: content.platform_meta.cover_asset_id ?? null,
    platform_code: LIEJU_PLATFORM_CODE,
    rule_version: LIEJU_RENDER_RULE_VERSION,
    schema_version: LIEJU_PAYLOAD_SCHEMA_VERSION,
    title: content.title,
  };
  const parsed = LiejuPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) => ({
        code: 'PAYLOAD_SCHEMA_INVALID' as const,
        message: issue.message,
        path: issue.path.map(String).join('.') || '$',
        severity: 'blocker' as const,
      })),
      ok: false,
    };
  }
  return { issues: [], ok: true, payload: parsed.data as LiejuPayload };
}

function renderText(content: LiejuContent): string {
  return content.blocks
    .map((block) => {
      const text = block.text.trim();
      if (block.block_type === 'heading') return text;
      if (block.block_type === 'list')
        return listItems(text)
          .map((item) => `- ${item}`)
          .join('\n');
      return text;
    })
    .join('\n\n');
}

function listItems(value: string): string[] {
  return value
    .split('\n')
    .map((item) => item.replace(/^[-*•]\s*/u, '').trim())
    .filter(Boolean);
}
