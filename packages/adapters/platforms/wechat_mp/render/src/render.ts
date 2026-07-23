import { WechatMpPayloadSchema } from './schema.js';
import {
  WECHAT_MP_PAYLOAD_SCHEMA_VERSION,
  WECHAT_MP_PLATFORM_CODE,
  WECHAT_MP_RENDER_RULE_VERSION,
  type WechatMpCitationLink,
  type WechatMpContent,
  type WechatMpInternalLink,
  type WechatMpPayload,
  type WechatMpRenderResult,
} from './types.js';
import { resolveWechatMpCta, validateWechatMpContent } from './validate.js';

export function renderWechatMp(input: unknown): WechatMpRenderResult {
  const validation = validateWechatMpContent(input);
  if (!validation.ok) return validation;
  const { citations, content, internal_links: internalLinks } = validation.value;
  const linkedIds = new Set(content.citation_map.flatMap((claim) => claim.citation_ids));
  const citationLinks = citations.filter((citation) => linkedIds.has(citation.citation_id));
  const cta = resolveWechatMpCta(content);
  const payload: WechatMpPayload = {
    author: content.platform_meta.author.trim(),
    body_html: renderHtml(content, internalLinks, citationLinks, cta),
    body_text: renderText(content, internalLinks, citationLinks, cta),
    citation_links: citationLinks,
    cover_asset_id: content.platform_meta.cover_asset_id,
    cta,
    digest: content.platform_meta.digest.trim(),
    internal_links: internalLinks,
    platform_code: WECHAT_MP_PLATFORM_CODE,
    rule_version: WECHAT_MP_RENDER_RULE_VERSION,
    schema_version: WECHAT_MP_PAYLOAD_SCHEMA_VERSION,
    title: content.title,
  };
  const parsed = WechatMpPayloadSchema.safeParse(payload);
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
  return { issues: [], ok: true, payload: parsed.data as WechatMpPayload };
}

function renderHtml(
  content: WechatMpContent,
  internalLinks: readonly WechatMpInternalLink[],
  citations: readonly WechatMpCitationLink[],
  cta: string,
): string {
  const blocks = content.blocks
    .filter((block) => block.block_type !== 'cta')
    .map(renderBlockHtml)
    .join('\n');
  return [
    '<article data-platform="wechat_mp">',
    `<h1>${escapeHtml(content.title)}</h1>`,
    `<p class="digest">${escapeHtml(content.platform_meta.digest.trim())}</p>`,
    blocks,
    renderLinksHtml('相关推荐', 'internal-links', internalLinks),
    citations.length ? renderLinksHtml('参考资料', 'references', citations) : '',
    `<aside class="cta">${escapeHtml(cta)}</aside>`,
    '</article>',
  ]
    .filter(Boolean)
    .join('\n');
}

function renderBlockHtml(block: WechatMpContent['blocks'][number]): string {
  const text = escapeHtml(block.text.trim());
  if (block.block_type === 'heading') return `<h2>${text}</h2>`;
  if (block.block_type === 'list')
    return `<ul>${listItems(block.text)
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join('')}</ul>`;
  if (block.block_type === 'quote') return `<blockquote>${text}</blockquote>`;
  if (block.block_type === 'media') return `<figure><figcaption>${text}</figcaption></figure>`;
  return `<p>${text}</p>`;
}

function renderLinksHtml(
  title: string,
  className: string,
  links: readonly { readonly citation_id?: string; readonly label: string; readonly url: string }[],
): string {
  const items = links
    .map((link) => {
      const citation = link.citation_id
        ? ` data-citation-id="${escapeHtml(link.citation_id)}"`
        : '';
      return `<li${citation}><a href="${escapeHtml(link.url)}" rel="noopener noreferrer">${escapeHtml(link.label)}</a></li>`;
    })
    .join('');
  return `<section class="${className}"><h2>${title}</h2><ul>${items}</ul></section>`;
}

function renderText(
  content: WechatMpContent,
  internalLinks: readonly WechatMpInternalLink[],
  citations: readonly WechatMpCitationLink[],
  cta: string,
): string {
  const blocks = content.blocks
    .filter((block) => block.block_type !== 'cta')
    .map((block) => {
      const text = block.text.trim();
      if (block.block_type === 'heading') return `## ${text}`;
      if (block.block_type === 'list')
        return listItems(text)
          .map((item) => `- ${item}`)
          .join('\n');
      if (block.block_type === 'quote') return `> ${text}`;
      if (block.block_type === 'media') return `媒体说明：${text}`;
      return text;
    });
  const related = internalLinks.map((link, index) => `${index + 1}. ${link.label} ${link.url}`);
  const references = citations.map(
    (citation, index) => `${index + 1}. ${citation.label} ${citation.url}`,
  );
  return [
    content.title,
    content.platform_meta.digest.trim(),
    ...blocks,
    '相关推荐',
    ...related,
    ...(references.length ? ['参考资料', ...references] : []),
    `行动建议：${cta}`,
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
