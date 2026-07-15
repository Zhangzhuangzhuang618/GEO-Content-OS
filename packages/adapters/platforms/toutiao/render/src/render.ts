import { ToutiaoPayloadSchema } from './schema.js';
import {
  TOUTIAO_PAYLOAD_SCHEMA_VERSION,
  TOUTIAO_PLATFORM_CODE,
  TOUTIAO_RENDER_RULE_VERSION,
  type ToutiaoCitationLink,
  type ToutiaoContent,
  type ToutiaoPayload,
  type ToutiaoRenderResult,
} from './types.js';
import { validateToutiaoContent } from './validate.js';

export function renderToutiao(input: unknown): ToutiaoRenderResult {
  const validation = validateToutiaoContent(input);
  if (!validation.ok) return validation;

  const { citations, content } = validation.value;
  const linkedIds = new Set(content.citation_map.flatMap((claim) => claim.citation_ids));
  const citationLinks = citations.filter((citation) => linkedIds.has(citation.citation_id));
  const payload: ToutiaoPayload = {
    body_html: renderHtml(content, citationLinks),
    body_text: renderText(content, citationLinks),
    citation_links: citationLinks,
    content_type: content.platform_meta.content_type,
    lead: content.platform_meta.lead,
    platform_code: TOUTIAO_PLATFORM_CODE,
    rule_version: TOUTIAO_RENDER_RULE_VERSION,
    schema_version: TOUTIAO_PAYLOAD_SCHEMA_VERSION,
    tags: content.platform_meta.tags,
    title: content.title,
  };
  const parsedPayload = ToutiaoPayloadSchema.safeParse(payload);
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
  return { issues: [], ok: true, payload: parsedPayload.data as ToutiaoPayload };
}

function renderHtml(content: ToutiaoContent, citations: readonly ToutiaoCitationLink[]): string {
  const blocks = content.blocks.map(renderBlockHtml).join('\n');
  const references = citations.length === 0 ? '' : renderReferencesHtml(citations);
  return [
    '<article data-platform="toutiao">',
    `<h1>${escapeHtml(content.title)}</h1>`,
    `<p class="lead">${escapeHtml(content.platform_meta.lead)}</p>`,
    blocks,
    references,
    '</article>',
  ]
    .filter(Boolean)
    .join('\n');
}

function renderBlockHtml(block: ToutiaoContent['blocks'][number]): string {
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

function renderReferencesHtml(citations: readonly ToutiaoCitationLink[]): string {
  const items = citations
    .map(
      (citation) =>
        `<li data-citation-id="${escapeHtml(citation.citation_id)}"><a href="${escapeHtml(citation.url)}" rel="noopener noreferrer">${escapeHtml(citation.label)}</a></li>`,
    )
    .join('');
  return `<section class="references"><h2>参考资料</h2><ol>${items}</ol></section>`;
}

function renderText(content: ToutiaoContent, citations: readonly ToutiaoCitationLink[]): string {
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
  const references = citations.map(
    (citation, index) => `${index + 1}. ${citation.label} ${citation.url}`,
  );
  return [
    content.title,
    content.platform_meta.lead,
    ...blocks,
    ...(references.length ? ['参考资料', ...references] : []),
  ].join('\n\n');
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
