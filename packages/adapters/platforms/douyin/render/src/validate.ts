import { DOUYIN_RENDER_RULES_V1 } from './rules.js';
import { DouyinRenderInputSchema } from './schema.js';
import type {
  DouyinImageNotePlatformMeta,
  DouyinRenderInput,
  DouyinScriptPlatformMeta,
  DouyinValidationCode,
  DouyinValidationIssue,
  DouyinValidationResult,
} from './types.js';

export function validateDouyinContent(input: unknown): DouyinValidationResult {
  const parsed = DouyinRenderInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) =>
        blocker('PAYLOAD_SCHEMA_INVALID', issue.message, pathOf(issue.path)),
      ),
      ok: false,
    };
  }
  const value = parsed.data as DouyinRenderInput;
  const issues: DouyinValidationIssue[] = [];
  const meta = value.content.platform_meta;
  if (isImageNote(meta)) validateImageNote(meta, issues);
  else validateScript(meta, issues);
  const allText = [
    value.content.title,
    value.content.summary,
    ...value.content.blocks.map((block) => block.text),
    ...(isImageNote(meta)
      ? [meta.description, ...meta.cards.flatMap((card) => [card.heading, card.body])]
      : [
          ...meta.storyboard.flatMap((scene) => [scene.visual, scene.voiceover]),
          ...meta.subtitles.map((subtitle) => subtitle.text),
        ]),
    value.content.cta ?? '',
  ].join('\n');
  if (DOUYIN_RENDER_RULES_V1.productionClaimMarkers.some((marker) => allText.includes(marker))) {
    issues.push(
      blocker('PRODUCTION_CLAIM_FORBIDDEN', '不得声称作品已制作、拍摄或发布。', 'content'),
    );
  }
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

function validateImageNote(
  meta: DouyinImageNotePlatformMeta,
  issues: DouyinValidationIssue[],
): void {
  if (
    meta.cards[0]?.kind !== 'cover' ||
    meta.cards.at(-1)?.kind !== 'summary' ||
    meta.cards.slice(1, -1).some((card) => card.kind !== 'body') ||
    new Set(meta.cards.map((card) => card.card_key)).size !== meta.cards.length
  ) {
    issues.push(
      blocker(
        'CARD_ORDER_INVALID',
        '图文必须以封面开始、以总结结束，中间仅包含正文卡片，且卡片标识不得重复。',
        'content.platform_meta.cards',
      ),
    );
  }
  if (
    !meta.image_asset_ids ||
    meta.image_asset_ids.length !== meta.cards.length ||
    new Set(meta.image_asset_ids).size !== meta.image_asset_ids.length
  ) {
    issues.push(
      blocker(
        'CARD_ASSET_COUNT_MISMATCH',
        '每张抖音图文卡片必须对应一张已通过媒体门禁的图片。',
        'content.platform_meta.image_asset_ids',
      ),
    );
  }
}

function validateScript(meta: DouyinScriptPlatformMeta, issues: DouyinValidationIssue[]): void {
  const { duration_seconds: duration, storyboard, subtitles, topics } = meta;
  if (storyboard.length === 0) {
    issues.push(
      blocker('STORYBOARD_REQUIRED', '必须提供至少一个分镜。', 'content.platform_meta.storyboard'),
    );
  }
  const first = storyboard[0];
  if (
    !first ||
    first.start_second !== 0 ||
    first.end_second <= 0 ||
    first.end_second > DOUYIN_RENDER_RULES_V1.hookMaximumSeconds ||
    !first.visual.trim() ||
    !first.voiceover.trim()
  ) {
    issues.push(
      blocker(
        'HOOK_REQUIRED',
        '首个分镜必须从 0 秒开始，在 3 秒内结束，并包含画面与口播。',
        'content.platform_meta.storyboard.0',
      ),
    );
  }
  if (subtitles.length === 0) {
    issues.push(
      blocker('SUBTITLE_REQUIRED', '必须提供至少一条字幕。', 'content.platform_meta.subtitles'),
    );
  }
  if (topics.length === 0) {
    issues.push(
      blocker('TOPIC_REQUIRED', '必须提供至少一个话题。', 'content.platform_meta.topics'),
    );
  }
  if (!timelineMatchesDuration(storyboard, subtitles, duration)) {
    issues.push(
      blocker(
        'DURATION_MISMATCH',
        '分镜和字幕时间必须递增、位于总时长内，且至少一项结束于总时长。',
        'content.platform_meta.duration_seconds',
      ),
    );
  }
}

function isImageNote(
  value: DouyinRenderInput['content']['platform_meta'],
): value is DouyinImageNotePlatformMeta {
  return value.content_kind === 'image_note';
}

function timelineMatchesDuration(
  storyboard: DouyinScriptPlatformMeta['storyboard'],
  subtitles: DouyinScriptPlatformMeta['subtitles'],
  duration: number,
): boolean {
  const entries = [...storyboard, ...subtitles];
  return (
    entries.length > 0 &&
    timelineIsOrdered(storyboard, duration) &&
    timelineIsOrdered(subtitles, duration) &&
    entries.some((entry) => entry.end_second === duration)
  );
}

function timelineIsOrdered(
  entries: readonly { readonly end_second: number; readonly start_second: number }[],
  duration: number,
): boolean {
  return entries.every((entry, index) => {
    const previous = entries[index - 1];
    return (
      entry.start_second < entry.end_second &&
      entry.end_second <= duration &&
      (!previous || entry.start_second >= previous.end_second)
    );
  });
}

function blocker(code: DouyinValidationCode, message: string, path: string): DouyinValidationIssue {
  return { code, message, path, severity: 'blocker' };
}
function pathOf(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '$' : path.map(String).join('.');
}
