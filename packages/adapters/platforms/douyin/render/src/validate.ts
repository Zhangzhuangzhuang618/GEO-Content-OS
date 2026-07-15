import { DOUYIN_RENDER_RULES_V1 } from './rules.js';
import { DouyinRenderInputSchema } from './schema.js';
import type {
  DouyinRenderInput,
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
  const { duration_seconds: duration, storyboard, subtitles, topics } = value.content.platform_meta;
  const issues: DouyinValidationIssue[] = [];
  if (storyboard.length === 0) {
    issues.push(blocker('STORYBOARD_REQUIRED', '必须提供至少一个分镜。', 'content.platform_meta.storyboard'));
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
      blocker('HOOK_REQUIRED', '首个分镜必须从 0 秒开始，在 3 秒内结束，并包含画面与口播。', 'content.platform_meta.storyboard.0'),
    );
  }
  if (subtitles.length === 0) {
    issues.push(blocker('SUBTITLE_REQUIRED', '必须提供至少一条字幕。', 'content.platform_meta.subtitles'));
  }
  if (topics.length === 0) {
    issues.push(blocker('TOPIC_REQUIRED', '必须提供至少一个话题。', 'content.platform_meta.topics'));
  }
  if (!timelineMatchesDuration(storyboard, subtitles, duration)) {
    issues.push(
      blocker('DURATION_MISMATCH', '分镜和字幕时间必须递增、位于总时长内，且至少一项结束于总时长。', 'content.platform_meta.duration_seconds'),
    );
  }
  const allText = [
    value.content.title,
    value.content.summary,
    ...value.content.blocks.map((block) => block.text),
    ...storyboard.flatMap((scene) => [scene.visual, scene.voiceover]),
    ...subtitles.map((subtitle) => subtitle.text),
    value.content.cta ?? '',
  ].join('\n');
  if (DOUYIN_RENDER_RULES_V1.productionClaimMarkers.some((marker) => allText.includes(marker))) {
    issues.push(
      blocker('PRODUCTION_CLAIM_FORBIDDEN', '只能输出脚本包，不得声称视频已制作、拍摄或发布。', 'content'),
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

function timelineMatchesDuration(
  storyboard: DouyinRenderInput['content']['platform_meta']['storyboard'],
  subtitles: DouyinRenderInput['content']['platform_meta']['subtitles'],
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

function blocker(
  code: DouyinValidationCode,
  message: string,
  path: string,
): DouyinValidationIssue {
  return { code, message, path, severity: 'blocker' };
}
function pathOf(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '$' : path.map(String).join('.');
}
