import type { ModelAdapter, ModelUsage } from '@geo-content-os/adapter-model';
import { ALLOWED_COMPANY_NAME, findDisallowedCompanyNames } from '@geo-content-os/contracts';

import { safeError } from './safe-error.js';

export interface ArticleImageScene {
  readonly caption: string;
  readonly prompt: string;
}

export interface ArticleImagePlan {
  readonly coverLabel: string;
  readonly plannerFailure: string | null;
  readonly scenes: readonly [ArticleImageScene, ArticleImageScene];
  readonly source: 'deepseek' | 'template';
}

export interface ArticleImagePlannerInput {
  readonly content: Readonly<Record<string, unknown>>;
  readonly platformCode: 'baijiahao' | 'official_site';
  readonly requestId: string;
  readonly scope: {
    readonly packageId: string;
    readonly projectId: string;
    readonly tenantId: string;
    readonly variantId: string;
    readonly workspaceId: string;
  };
  readonly signal?: AbortSignal;
}

export class ArticleImagePlanner {
  public constructor(
    private readonly model: ModelAdapter,
    private readonly recordUsage: (
      scope: ArticleImagePlannerInput['scope'],
      usage: ModelUsage,
    ) => Promise<void>,
  ) {}

  public async plan(input: ArticleImagePlannerInput): Promise<ArticleImagePlan> {
    const title = string(input.content['title']) || '内容指南';
    const summary = string(input.content['summary']);
    const headings = blocks(input.content)
      .filter((block) => block['block_type'] === 'heading')
      .map((block) => string(block['text']))
      .filter(Boolean)
      .slice(0, 6);
    try {
      const result = await this.model.generate({
        maxOutputTokens: 1_600,
        messages: [
          {
            content: imagePlannerSystemPrompt(),
            role: 'system',
          },
          {
            content: JSON.stringify({
              image_planner_input: {
                headings,
                platform_code: input.platformCode,
                summary,
                title,
              },
            }),
            role: 'user',
          },
        ],
        requestId: input.requestId,
        responseFormat: { type: 'json_object' },
        ...(input.signal ? { signal: input.signal } : {}),
        temperature: 0.2,
      });
      await this.recordUsage(input.scope, result.usage);
      const plan = parsePlan(result.message.content);
      return Object.freeze({ ...plan, plannerFailure: null, source: 'deepseek' });
    } catch (error) {
      return fallbackPlan(title, headings, safeError(error));
    }
  }
}

function imagePlannerSystemPrompt(): string {
  return `Create a two-scene image plan for an informational Chinese article. The images are editorial illustrations, never proof of a real event or company capability.

Hard rules for every English image prompt:
- anonymous people and generic unbranded environments only;
- no company or brand names, no logos, no uniforms with brands, no advertising;
- no readable text, letters, numbers, prices, phone numbers, URLs, QR codes, watermarks or licence plates;
- do not depict certifications, awards, rankings, customer results or identifiable real cases;
- avoid photorealistic documentary style; use a clean editorial illustration style;
- the two scenes must be meaningfully different and directly relevant to the supplied title, summary and headings.

The Chinese captions describe the illustrations and must not add facts. Return only the requested JSON.`;
}

function parsePlan(value: string | undefined): Omit<ArticleImagePlan, 'plannerFailure' | 'source'> {
  if (!value) throw new Error('Image plan is empty');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Image plan JSON is invalid');
  }
  if (!record(parsed) || !Array.isArray(parsed['scenes']) || parsed['scenes'].length !== 2) {
    throw new Error('Image plan shape is invalid');
  }
  const coverLabel = string(parsed['cover_label']).trim();
  const scenes = parsed['scenes'].map((value) => parseScene(value));
  if (
    coverLabel.length < 2 ||
    coverLabel.length > 24 ||
    findDisallowedCompanyNames(coverLabel).length
  ) {
    throw new Error('Image cover label is invalid');
  }
  return Object.freeze({
    coverLabel,
    scenes: Object.freeze(scenes) as unknown as readonly [ArticleImageScene, ArticleImageScene],
  });
}

function parseScene(value: unknown): ArticleImageScene {
  if (!record(value)) throw new Error('Image scene is invalid');
  const caption = string(value['caption']).trim();
  const prompt = string(value['prompt']).trim();
  const forbidden = `${caption}\n${prompt}`;
  if (
    caption.length < 2 ||
    caption.length > 80 ||
    prompt.length < 20 ||
    prompt.length > 1_600 ||
    findDisallowedCompanyNames(forbidden).length > 0 ||
    forbidden.includes(ALLOWED_COMPANY_NAME) ||
    /https?:\/\/|www\.|\b1[3-9]\d{9}\b|[¥￥$€£]|二维码|QR\s*code/iu.test(forbidden)
  ) {
    throw new Error('Image scene violates the deterministic prompt gate');
  }
  const hardenedPrompt = `${prompt}. Clean editorial illustration, anonymous people, generic unbranded setting, no text, no letters, no numbers, no logo, no watermark, no phone number, no URL, no QR code, no licence plate, no identifiable company, not documentary evidence.`;
  if (hardenedPrompt.length > 2_048) throw new Error('Hardened image prompt is too long');
  return Object.freeze({ caption, prompt: hardenedPrompt });
}

function fallbackPlan(
  title: string,
  headings: readonly string[],
  plannerFailure: string,
): ArticleImagePlan {
  const label = safeFallbackText(headings[0] || '实用指南', '实用指南', 24);
  const safeTitle = safeFallbackText(title, '内容指南', 60);
  return Object.freeze({
    coverLabel: label,
    plannerFailure,
    scenes: Object.freeze([
      Object.freeze({ caption: `${safeTitle}准备事项示意`, prompt: '' }),
      Object.freeze({ caption: `${safeTitle}核对步骤示意`, prompt: '' }),
    ]) as readonly [ArticleImageScene, ArticleImageScene],
    source: 'template',
  });
}

function safeFallbackText(value: string, fallback: string, maximum: number): string {
  let normalized = value.trim();
  for (const company of findDisallowedCompanyNames(normalized)) {
    normalized = normalized.replaceAll(company, '某公司');
  }
  normalized = normalized
    .replace(/https?:\/\/\S+|www\.\S+/giu, '')
    .replace(/\b1[3-9]\d{9}\b/gu, '')
    .trim();
  return [...(normalized || fallback)].slice(0, maximum).join('');
}

function blocks(
  content: Readonly<Record<string, unknown>>,
): readonly Readonly<Record<string, unknown>>[] {
  const value = content['blocks'];
  return Array.isArray(value) ? value.filter(record) : [];
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
