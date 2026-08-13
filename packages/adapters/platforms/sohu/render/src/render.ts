import { SohuPayloadSchema } from './schema.js';
import {
  SOHU_PAYLOAD_SCHEMA_VERSION,
  SOHU_PLATFORM_CODE,
  SOHU_RENDER_RULE_VERSION,
  type SohuContent,
  type SohuPayload,
  type SohuRenderResult,
} from './types.js';
import { validateSohuContent } from './validate.js';

export function renderSohu(input: unknown): SohuRenderResult {
  const validation = validateSohuContent(input);
  if (!validation.ok) return validation;
  const content = validation.value.content;
  const payload: SohuPayload = {
    abstract: content.platform_meta.abstract,
    ai_generated: true,
    body_html: renderHtml(content),
    body_asset_ids: Object.freeze([...(content.platform_meta.body_asset_ids ?? [])]),
    body_text: renderText(content),
    citation_links: Object.freeze([]),
    content_type: content.platform_meta.content_type,
    cover_asset_id: content.platform_meta.cover_asset_id ?? null,
    original: false,
    platform_code: SOHU_PLATFORM_CODE,
    rule_version: SOHU_RENDER_RULE_VERSION,
    schema_version: SOHU_PAYLOAD_SCHEMA_VERSION,
    title: content.title,
  };
  const parsed = SohuPayloadSchema.safeParse(payload);
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
  return { issues: [], ok: true, payload: parsed.data as SohuPayload };
}

function renderHtml(content: SohuContent): string {
  return `<article data-platform="sohu">\n${content.blocks.map(renderBlockHtml).join('\n')}\n</article>`;
}

function renderBlockHtml(block: SohuContent['blocks'][number]): string {
  const text = escapeHtml(block.text.trim());
  if (block.block_type === 'heading') return `<h2>${text}</h2>`;
  if (block.block_type === 'list') {
    return `<ul>${listItems(block.text)
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join('')}</ul>`;
  }
  if (block.block_type === 'quote') return `<blockquote>${text}</blockquote>`;
  if (block.block_type === 'media') return `<figure><figcaption>${text}</figcaption></figure>`;
  if (block.block_type === 'cta') return `<aside>${text}</aside>`;
  return `<p>${text}</p>`;
}

function renderText(content: SohuContent): string {
  return content.blocks
    .map((block) => {
      const text = block.text.trim();
      if (block.block_type === 'heading') return `## ${text}`;
      if (block.block_type === 'list')
        return listItems(text)
          .map((item) => `- ${item}`)
          .join('\n');
      if (block.block_type === 'quote') return `> ${text}`;
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

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
