import { DouyinPayloadSchema } from './schema.js';
import {
  DOUYIN_IMAGE_NOTE_PAYLOAD_SCHEMA_VERSION,
  DOUYIN_PAYLOAD_SCHEMA_VERSION,
  DOUYIN_PLATFORM_CODE,
  DOUYIN_RENDER_RULE_VERSION,
  type DouyinCitationLink,
  type DouyinImageNotePlatformMeta,
  type DouyinImageNotePayload,
  type DouyinPayload,
  type DouyinRenderResult,
  type DouyinScriptPlatformMeta,
  type DouyinStoryboardScene,
  type DouyinSubtitle,
} from './types.js';
import { validateDouyinContent } from './validate.js';

export function renderDouyin(input: unknown): DouyinRenderResult {
  const validation = validateDouyinContent(input);
  if (!validation.ok) return validation;
  const { citations, content } = validation.value;
  const meta = content.platform_meta;
  const linkedIds = new Set(content.citation_map.flatMap((claim) => claim.citation_ids));
  const citationLinks = citations.filter((citation) => linkedIds.has(citation.citation_id));
  const payload: DouyinPayload =
    meta.content_kind === 'image_note'
      ? imageNotePayload(content.title, meta, citationLinks)
      : scriptPayload(content.title, meta, citationLinks);
  const parsed = DouyinPayloadSchema.safeParse(payload);
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
  return { issues: [], ok: true, payload: parsed.data as DouyinPayload };
}

function imageNotePayload(
  title: string,
  meta: DouyinImageNotePlatformMeta,
  citations: readonly DouyinCitationLink[],
): DouyinImageNotePayload {
  return {
    ai_generated: true,
    cards: meta.cards,
    citation_links: citations,
    content_kind: 'image_note',
    description: meta.description,
    image_asset_ids: meta.image_asset_ids ?? [],
    platform_code: DOUYIN_PLATFORM_CODE,
    rule_version: DOUYIN_RENDER_RULE_VERSION,
    schema_version: DOUYIN_IMAGE_NOTE_PAYLOAD_SCHEMA_VERSION,
    title,
    topics: meta.topics,
  };
}

function scriptPayload(
  title: string,
  meta: DouyinScriptPlatformMeta,
  citationLinks: readonly DouyinCitationLink[],
): DouyinPayload {
  return {
    citation_links: citationLinks,
    duration_seconds: meta.duration_seconds,
    hook: meta.storyboard[0]!.voiceover.trim(),
    platform_code: DOUYIN_PLATFORM_CODE,
    rule_version: DOUYIN_RENDER_RULE_VERSION,
    schema_version: DOUYIN_PAYLOAD_SCHEMA_VERSION,
    script_kind: 'script_package',
    script_text: renderScriptText(
      title,
      meta.duration_seconds,
      meta.storyboard,
      meta.subtitles,
      meta.topics,
      citationLinks,
    ),
    storyboard: meta.storyboard,
    subtitles: meta.subtitles,
    title,
    topics: meta.topics,
  };
}

function renderScriptText(
  title: string,
  duration: number,
  storyboard: readonly DouyinStoryboardScene[],
  subtitles: readonly DouyinSubtitle[],
  topics: readonly string[],
  citations: readonly DouyinCitationLink[],
): string {
  const scenes = storyboard.map(
    (scene, index) =>
      `${index + 1}. [${formatSecond(scene.start_second)}-${formatSecond(scene.end_second)}秒] 画面：${scene.visual.trim()}｜口播：${scene.voiceover.trim()}`,
  );
  const subtitleLines = subtitles.map(
    (subtitle, index) =>
      `${index + 1}. [${formatSecond(subtitle.start_second)}-${formatSecond(subtitle.end_second)}秒] ${subtitle.text.trim()}`,
  );
  const references = citations.map(
    (citation, index) => `${index + 1}. ${citation.label} ${citation.url}`,
  );
  return [
    `标题：${title}`,
    `脚本类型：抖音口播脚本包（不含成片）`,
    `总时长：${formatSecond(duration)}秒`,
    `3秒钩子：${storyboard[0]!.voiceover.trim()}`,
    '分镜与口播',
    ...scenes,
    '字幕',
    ...subtitleLines,
    `话题：${topics.map((topic) => `#${topic}`).join(' ')}`,
    ...(references.length ? ['参考资料', ...references] : []),
  ].join('\n\n');
}

function formatSecond(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/u, '');
}
