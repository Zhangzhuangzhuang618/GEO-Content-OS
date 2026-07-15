import { XiaohongshuPayloadSchema } from './schema.js';
import {
  XIAOHONGSHU_PAYLOAD_SCHEMA_VERSION,
  XIAOHONGSHU_PLATFORM_CODE,
  XIAOHONGSHU_RENDER_RULE_VERSION,
  type XiaohongshuCitationLink,
  type XiaohongshuContent,
  type XiaohongshuPayload,
  type XiaohongshuRenderResult,
} from './types.js';
import { validateXiaohongshuContent } from './validate.js';

export function renderXiaohongshu(input: unknown): XiaohongshuRenderResult {
  const validation = validateXiaohongshuContent(input);
  if (!validation.ok) return validation;
  const { citations, content } = validation.value;
  const linkedIds = new Set(content.citation_map.flatMap((claim) => claim.citation_ids));
  const citationLinks = citations.filter((citation) => linkedIds.has(citation.citation_id));
  const payload: XiaohongshuPayload = {
    body_html: renderHtml(content, citationLinks),
    body_text: renderText(content, citationLinks),
    citation_links: citationLinks,
    cover_text: content.platform_meta.cover_text,
    note_type: content.platform_meta.note_type,
    platform_code: XIAOHONGSHU_PLATFORM_CODE,
    rule_version: XIAOHONGSHU_RENDER_RULE_VERSION,
    schema_version: XIAOHONGSHU_PAYLOAD_SCHEMA_VERSION,
    title: content.title,
    topics: content.platform_meta.topics,
  };
  const parsed = XiaohongshuPayloadSchema.safeParse(payload);
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
  return { issues: [], ok: true, payload: parsed.data as XiaohongshuPayload };
}

function renderHtml(
  content: XiaohongshuContent,
  citations: readonly XiaohongshuCitationLink[],
): string {
  const blocks = content.blocks.map(renderBlockHtml).join('\n');
  const references = citations.length ? renderReferencesHtml(citations) : '';
  return [
    '<article data-platform="xiaohongshu">',
    `<h1>${escapeHtml(content.title)}</h1>`,
    blocks,
    references,
    '</article>',
  ]
    .filter(Boolean)
    .join('\n');
}

function renderBlockHtml(block: XiaohongshuContent['blocks'][number]): string {
  const text = escapeHtml(block.text.trim());
  if (block.block_type === 'heading') return `<h2>${text}</h2>`;
  if (block.block_type === 'list')
    return `<ul>${listItems(block.text)
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join('')}</ul>`;
  if (block.block_type === 'quote') return `<blockquote>${text}</blockquote>`;
  if (block.block_type === 'media') return `<figure><figcaption>${text}</figcaption></figure>`;
  if (block.block_type === 'cta') return `<aside>${text}</aside>`;
  return `<p>${text}</p>`;
}

function renderReferencesHtml(citations: readonly XiaohongshuCitationLink[]): string {
  const items = citations
    .map(
      (citation) =>
        `<li data-citation-id="${escapeHtml(citation.citation_id)}"><a href="${escapeHtml(citation.url)}" rel="noopener noreferrer">${escapeHtml(citation.label)}</a></li>`,
    )
    .join('');
  return `<section class="references"><h2>参考资料</h2><ol>${items}</ol></section>`;
}

function renderText(
  content: XiaohongshuContent,
  citations: readonly XiaohongshuCitationLink[],
): string {
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
  return [content.title, ...blocks, ...(references.length ? ['参考资料', ...references] : [])].join(
    '\n\n',
  );
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
