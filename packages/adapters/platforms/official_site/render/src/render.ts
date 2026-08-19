import { OfficialSitePayloadSchema } from './schema.js';
import { validateOfficialSiteContent } from './validate.js';
import {
  OFFICIAL_SITE_PAYLOAD_SCHEMA_VERSION,
  OFFICIAL_SITE_PLATFORM_CODE,
  OFFICIAL_SITE_RENDER_RULE_VERSION,
  type OfficialSiteCitationLink,
  type OfficialSiteContent,
  type OfficialSiteFaqItem,
  type OfficialSiteMediaAsset,
  type OfficialSitePayload,
  type OfficialSiteRenderResult,
} from './types.js';

export function renderOfficialSite(input: unknown): OfficialSiteRenderResult {
  const validation = validateOfficialSiteContent(input);
  if (!validation.ok) return validation;

  const { citations, content, media_assets: mediaAssets = [] } = validation.value;
  const linkedIds = new Set(content.citation_map.flatMap((claim) => claim.citation_ids));
  const citationLinks = citations.filter((citation) => linkedIds.has(citation.citation_id));
  const payload: OfficialSitePayload = {
    body_html: renderPublishBodyHtml(content, citationLinks, mediaAssets),
    citation_links: citationLinks,
    faq: content.platform_meta.faq,
    html: renderHtml(content, citationLinks, mediaAssets),
    markdown: renderMarkdown(content, citationLinks, mediaAssets),
    meta_description: content.platform_meta.meta_description,
    platform_code: OFFICIAL_SITE_PLATFORM_CODE,
    rule_version: OFFICIAL_SITE_RENDER_RULE_VERSION,
    schema_org: content.platform_meta.schema_org,
    schema_version: OFFICIAL_SITE_PAYLOAD_SCHEMA_VERSION,
    seo_keywords: content.hashtags,
    slug: content.platform_meta.slug,
    summary: content.summary,
    title: content.title,
  };
  const parsedPayload = OfficialSitePayloadSchema.safeParse(payload);
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
  return { issues: [], ok: true, payload: parsedPayload.data as OfficialSitePayload };
}

function renderPublishBodyHtml(
  content: OfficialSiteContent,
  citations: readonly OfficialSiteCitationLink[],
  mediaAssets: readonly OfficialSiteMediaAsset[],
): string {
  return [
    renderContentBlocks(content, mediaAssets),
    renderFaqHtml(content.platform_meta.faq),
    renderReferencesHtml(citations),
  ]
    .filter(Boolean)
    .join('\n');
}

function renderHtml(
  content: OfficialSiteContent,
  citations: readonly OfficialSiteCitationLink[],
  mediaAssets: readonly OfficialSiteMediaAsset[],
): string {
  const parts = [
    '<article data-platform="official_site">',
    `<h1>${escapeHtml(content.title)}</h1>`,
    renderContentBlocks(content, mediaAssets),
    renderFaqHtml(content.platform_meta.faq),
    renderReferencesHtml(citations),
    `<script type="application/ld+json">${safeJson(content.platform_meta.schema_org)}</script>`,
    '</article>',
  ];
  return parts.filter(Boolean).join('\n');
}

function renderContentBlocks(
  content: OfficialSiteContent,
  mediaAssets: readonly OfficialSiteMediaAsset[],
): string {
  const cover = mediaAssets.find((asset) => asset.role === 'cover');
  const body = mediaAssets
    .filter((asset) => asset.role === 'body')
    .sort((left, right) => left.position - right.position);
  const parts: string[] = cover ? [renderImageHtml(cover)] : [];
  let imageIndex = 0;
  for (const block of content.blocks) {
    parts.push(renderBlockHtml(block));
    if (block.block_type === 'heading' && body[imageIndex]) {
      parts.push(renderImageHtml(body[imageIndex] as OfficialSiteMediaAsset));
      imageIndex += 1;
    }
  }
  parts.push(...body.slice(imageIndex).map(renderImageHtml));
  return parts.join('\n');
}

function renderImageHtml(asset: OfficialSiteMediaAsset): string {
  const sourceAttribute = asset.source === 'certificate' ? ' data-image-source="certificate"' : '';
  return `<figure class="article-image" data-image-role="${asset.role}"${sourceAttribute}><img src="${escapeHtml(asset.url)}" alt="${escapeHtml(asset.alt_text)}" loading="lazy" decoding="async"/><figcaption>${escapeHtml(imageCaption(asset))}</figcaption></figure>`;
}

function renderBlockHtml(block: {
  readonly block_type: 'cta' | 'heading' | 'list' | 'media' | 'paragraph' | 'quote';
  readonly text: string;
}): string {
  const text = escapeHtml(block.text.trim());
  switch (block.block_type) {
    case 'heading':
      return `<h2>${text}</h2>`;
    case 'list': {
      const items = block.text
        .split('\n')
        .map((item) => item.replace(/^[-*•]\s*/u, '').trim())
        .filter(Boolean)
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join('');
      return `<ul>${items}</ul>`;
    }
    case 'quote':
      return `<blockquote>${text}</blockquote>`;
    case 'media':
      return `<figure><figcaption>${text}</figcaption></figure>`;
    case 'cta':
      return `<aside class="cta">${text}</aside>`;
    default:
      return `<p>${text}</p>`;
  }
}

function renderFaqHtml(faq: readonly OfficialSiteFaqItem[]): string {
  const items = faq
    .map(
      (item) =>
        `<section class="faq-item"><h3>${escapeHtml(item.question)}</h3><p>${escapeHtml(item.answer)}</p></section>`,
    )
    .join('\n');
  return `<section class="faq"><h2>常见问题</h2>\n${items}\n</section>`;
}

function renderReferencesHtml(citations: readonly OfficialSiteCitationLink[]): string {
  if (citations.length === 0) return '';
  const items = citations
    .map(
      (citation) =>
        `<li data-citation-id="${escapeHtml(citation.citation_id)}"><a href="${escapeHtml(citation.url)}" rel="noopener noreferrer">${escapeHtml(citation.label)}</a></li>`,
    )
    .join('');
  return `<section class="references"><h2>参考资料</h2><ol>${items}</ol></section>`;
}

function renderMarkdown(
  content: OfficialSiteContent,
  citations: readonly OfficialSiteCitationLink[],
  mediaAssets: readonly OfficialSiteMediaAsset[],
): string {
  const cover = mediaAssets.find((asset) => asset.role === 'cover');
  const body = mediaAssets
    .filter((asset) => asset.role === 'body')
    .sort((left, right) => left.position - right.position);
  const blocks: string[] = [];
  let imageIndex = 0;
  for (const block of content.blocks) {
    const text = block.text.trim();
    let rendered: string;
    switch (block.block_type) {
      case 'heading':
        rendered = `## ${text}`;
        break;
      case 'list':
        rendered = text
          .split('\n')
          .map((item) => item.replace(/^[-*•]\s*/u, '').trim())
          .filter(Boolean)
          .map((item) => `- ${item}`)
          .join('\n');
        break;
      case 'quote':
        rendered = text
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n');
        break;
      case 'media':
        rendered = `> 媒体说明：${text}`;
        break;
      case 'cta':
        rendered = `**行动建议：** ${text}`;
        break;
      default:
        rendered = text;
    }
    blocks.push(rendered);
    if (block.block_type === 'heading' && body[imageIndex]) {
      blocks.push(renderImageMarkdown(body[imageIndex] as OfficialSiteMediaAsset));
      imageIndex += 1;
    }
  }
  blocks.push(...body.slice(imageIndex).map(renderImageMarkdown));
  const faq = content.platform_meta.faq.flatMap((item) => [`### ${item.question}`, item.answer]);
  const references = citations.map(
    (citation, index) =>
      `${index + 1}. [${escapeMarkdownLabel(citation.label)}](${citation.url}) <!-- ${citation.citation_id} -->`,
  );
  const sections = [
    `# ${content.title}`,
    ...(cover ? [renderImageMarkdown(cover)] : []),
    ...blocks,
    '## 常见问题',
    ...faq,
  ];
  if (references.length > 0) sections.push('## 参考资料', ...references);
  return sections.join('\n\n');
}

function renderImageMarkdown(asset: OfficialSiteMediaAsset): string {
  return `![${escapeMarkdownLabel(asset.alt_text)}](${asset.url})\n\n*${imageCaption(asset)}*`;
}

function imageCaption(asset: OfficialSiteMediaAsset): string {
  return asset.source === 'certificate'
    ? `${asset.alt_text}（企业证照，请按编号或官方渠道核验）`
    : `${asset.alt_text}（AI示意图）`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeMarkdownLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]');
}

function safeJson(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(value)
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}
