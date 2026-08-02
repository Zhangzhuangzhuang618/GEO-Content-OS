import { BaijiahaoPayloadSchema } from './schema.js';
import {
  BAIJIAHAO_PAYLOAD_SCHEMA_VERSION,
  BAIJIAHAO_PLATFORM_CODE,
  BAIJIAHAO_RENDER_RULE_VERSION,
  type BaijiahaoCitationLink,
  type BaijiahaoContent,
  type BaijiahaoPayload,
  type BaijiahaoRenderResult,
} from './types.js';
import { validateBaijiahaoContent } from './validate.js';

export function renderBaijiahao(input: unknown): BaijiahaoRenderResult {
  const validation = validateBaijiahaoContent(input);
  if (!validation.ok) return validation;

  const { citations, content } = validation.value;
  // Citations remain server-side provenance. Baijiahao public copy must not expose third-party URLs.
  void citations;
  const citationLinks: readonly BaijiahaoCitationLink[] = Object.freeze([]);
  const payload: BaijiahaoPayload = {
    abstract: content.platform_meta.abstract,
    body_html: renderHtml(content),
    body_asset_ids: Object.freeze([...(content.platform_meta.body_asset_ids ?? [])]),
    body_text: renderText(content),
    citation_links: citationLinks,
    content_type: content.platform_meta.content_type,
    cover_asset_id: content.platform_meta.cover_asset_id ?? null,
    platform_code: BAIJIAHAO_PLATFORM_CODE,
    rule_version: BAIJIAHAO_RENDER_RULE_VERSION,
    schema_version: BAIJIAHAO_PAYLOAD_SCHEMA_VERSION,
    tags: content.platform_meta.tags,
    title: content.title,
  };
  const parsedPayload = BaijiahaoPayloadSchema.safeParse(payload);
  if (!parsedPayload.success) {
    return {
      issues: parsedPayload.error.issues.map((issue) => ({
        code: 'PAYLOAD_SCHEMA_INVALID' as const,
        message: issue.message,
        path: issue.path.map(String).join('.') || '$',
        severity: 'blocker' as const,
      })),
      ok: false,
    };
  }
  return { issues: [], ok: true, payload: parsedPayload.data as BaijiahaoPayload };
}

function renderHtml(content: BaijiahaoContent): string {
  const blocks = content.blocks.map(renderBlockHtml).join('\n');
  return [
    '<article data-platform="baijiahao">',
    `<h1>${escapeHtml(content.title)}</h1>`,
    blocks,
    '</article>',
  ]
    .filter(Boolean)
    .join('\n');
}

function renderBlockHtml(block: BaijiahaoContent['blocks'][number]): string {
  const text = escapeHtml(block.text.trim());
  switch (block.block_type) {
    case 'heading':
      return `<h2>${text}</h2>`;
    case 'list':
      return `<ul>${listItems(block.text)
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join('')}</ul>`;
    case 'quote':
      return `<blockquote>${text}</blockquote>`;
    case 'media':
      return `<figure><figcaption>${text}</figcaption></figure>`;
    case 'cta':
      return `<aside>${text}</aside>`;
    default:
      return `<p>${text}</p>`;
  }
}

function renderText(content: BaijiahaoContent): string {
  const blocks = content.blocks.map((block) => {
    const text = block.text.trim();
    if (block.block_type === 'heading') return `## ${text}`;
    if (block.block_type === 'list')
      return listItems(text)
        .map((item) => `- ${item}`)
        .join('\n');
    if (block.block_type === 'quote') return `> ${text}`;
    if (block.block_type === 'media') return `媒体说明：${text}`;
    if (block.block_type === 'cta') return `行动建议：${text}`;
    return text;
  });
  return [content.title, ...blocks].join('\n\n');
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
