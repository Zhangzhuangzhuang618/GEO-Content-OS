import type { ModelAdapter, ModelUsage } from '@geo-content-os/adapter-model';
import { findDisallowedCompanyNames } from '@geo-content-os/contracts';
import { createHash } from 'node:crypto';

import { safeError } from './safe-error.js';

export interface ArticleImageScene {
  readonly caption: string;
  readonly prompt: string;
}

export interface ArticleImagePlan {
  readonly coverLabel: string;
  readonly plannerDiagnostics: ArticleImagePlannerDiagnostics;
  readonly plannerFailure: string | null;
  readonly scenes: readonly [ArticleImageScene, ArticleImageScene];
  readonly source: 'deepseek' | 'template';
}

export interface ArticleImagePlannerDiagnostics {
  readonly attempts: 1 | 2;
  readonly initialResponse: ArticleImagePlannerResponseDiagnostic | null;
  readonly repairResponse: ArticleImagePlannerResponseDiagnostic | null;
  readonly repaired: boolean;
}

export interface ArticleImagePlannerResponseDiagnostic {
  readonly failure: string | null;
  readonly responseCharacters: number;
  readonly responseHash: string;
  readonly responsePreview: string;
  readonly sceneCount: number | null;
  readonly topLevelKeys: readonly string[];
}

export interface ArticleImagePlannerInput {
  readonly content: Readonly<Record<string, unknown>>;
  readonly platformCode: 'baijiahao' | 'lieju' | 'official_site' | 'sohu';
  readonly requestId: string;
  readonly scope: ImagePlannerScope;
  readonly signal?: AbortSignal;
}

export interface DouyinImageNotePlanningCard {
  readonly body: string;
  readonly cardKey: string;
  readonly heading: string;
  readonly kind: 'cover' | 'body' | 'summary';
}

export interface DouyinImageNoteVisual {
  readonly caption: string;
  readonly cardKey: string;
  readonly prompt: string;
}

export interface DouyinImageNoteVisualPlan {
  readonly plannerDiagnostics: ArticleImagePlannerDiagnostics;
  readonly plannerFailure: string | null;
  readonly source: 'deepseek' | 'template';
  readonly visuals: readonly DouyinImageNoteVisual[];
}

export interface DouyinImageNotePlannerInput {
  readonly cards: readonly DouyinImageNotePlanningCard[];
  readonly description: string;
  readonly requestId: string;
  readonly scope: ImagePlannerScope;
  readonly signal?: AbortSignal;
  readonly title: string;
}

interface ImagePlannerScope {
  readonly packageId: string;
  readonly projectId: string;
  readonly tenantId: string;
  readonly variantId: string;
  readonly workspaceId: string;
}

export class ArticleImagePlanner {
  public constructor(
    private readonly model: ModelAdapter,
    private readonly recordUsage: (scope: ImagePlannerScope, usage: ModelUsage) => Promise<void>,
  ) {}

  public async plan(input: ArticleImagePlannerInput): Promise<ArticleImagePlan> {
    const title = string(input.content['title']) || '内容指南';
    const summary = string(input.content['summary']);
    const headings = blocks(input.content)
      .filter((block) => block['block_type'] === 'heading')
      .map((block) => string(block['text']))
      .filter(Boolean)
      .slice(0, 6);
    const plannerInput = Object.freeze({
      headings,
      platform_code: input.platformCode,
      summary,
      title,
    });
    let initialContent: string | undefined;
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
              image_planner_input: plannerInput,
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
      initialContent = result.message.content;
    } catch (error) {
      return fallbackPlan(title, headings, safeError(error), {
        attempts: 1,
        initialResponse: null,
        repairResponse: null,
        repaired: false,
      });
    }

    try {
      const plan = parsePlan(initialContent);
      return Object.freeze({
        ...plan,
        plannerDiagnostics: Object.freeze({
          attempts: 1,
          initialResponse: responseDiagnostic(initialContent, null),
          repairResponse: null,
          repaired: false,
        }),
        plannerFailure: null,
        source: 'deepseek',
      });
    } catch (initialError) {
      const initialFailure = safeError(initialError);
      const initialDiagnostic = responseDiagnostic(initialContent, initialFailure);
      let repairContent: string | undefined;
      try {
        const repaired = await this.model.generate({
          maxOutputTokens: 1_600,
          messages: [
            {
              content: imagePlannerRepairSystemPrompt(),
              role: 'system',
            },
            {
              content: JSON.stringify({
                image_plan_repair_input: {
                  invalid_output: initialContent ?? '',
                  original_input: plannerInput,
                  validation_error: initialFailure,
                },
              }),
              role: 'user',
            },
          ],
          requestId: `${input.requestId}:repair`,
          responseFormat: { type: 'json_object' },
          ...(input.signal ? { signal: input.signal } : {}),
          temperature: 0,
        });
        await this.recordUsage(input.scope, repaired.usage);
        repairContent = repaired.message.content;
      } catch (repairError) {
        return fallbackPlan(
          title,
          headings,
          combinedPlannerFailure(initialFailure, safeError(repairError)),
          {
            attempts: 2,
            initialResponse: initialDiagnostic,
            repairResponse: null,
            repaired: false,
          },
        );
      }
      try {
        const plan = parsePlan(repairContent);
        return Object.freeze({
          ...plan,
          plannerDiagnostics: Object.freeze({
            attempts: 2,
            initialResponse: initialDiagnostic,
            repairResponse: responseDiagnostic(repairContent, null),
            repaired: true,
          }),
          plannerFailure: null,
          source: 'deepseek',
        });
      } catch (repairError) {
        const repairFailure = safeError(repairError);
        return fallbackPlan(
          title,
          headings,
          combinedPlannerFailure(initialFailure, repairFailure),
          {
            attempts: 2,
            initialResponse: initialDiagnostic,
            repairResponse: responseDiagnostic(repairContent, repairFailure),
            repaired: false,
          },
        );
      }
    }
  }

  public async planDouyin(input: DouyinImageNotePlannerInput): Promise<DouyinImageNoteVisualPlan> {
    const plannerInput = Object.freeze({
      cards: input.cards,
      description: input.description,
      title: input.title,
    });
    let initialContent: string | undefined;
    try {
      const result = await this.model.generate({
        maxOutputTokens: 3_200,
        messages: [
          { content: douyinImagePlannerSystemPrompt(), role: 'system' },
          {
            content: JSON.stringify({ douyin_image_planner_input: plannerInput }),
            role: 'user',
          },
        ],
        requestId: `${input.requestId}:douyin`,
        responseFormat: { type: 'json_object' },
        ...(input.signal ? { signal: input.signal } : {}),
        temperature: 0.25,
      });
      await this.recordUsage(input.scope, result.usage);
      initialContent = result.message.content;
    } catch (error) {
      return fallbackDouyinPlan(safeError(error), {
        attempts: 1,
        initialResponse: null,
        repairResponse: null,
        repaired: false,
      });
    }

    try {
      const visuals = parseDouyinVisualPlan(initialContent, input.cards);
      return Object.freeze({
        plannerDiagnostics: Object.freeze({
          attempts: 1,
          initialResponse: responseDiagnostic(initialContent, null),
          repairResponse: null,
          repaired: false,
        }),
        plannerFailure: null,
        source: 'deepseek',
        visuals,
      });
    } catch (initialError) {
      const initialFailure = safeError(initialError);
      const initialDiagnostic = responseDiagnostic(initialContent, initialFailure);
      let repairContent: string | undefined;
      try {
        const repaired = await this.model.generate({
          maxOutputTokens: 3_200,
          messages: [
            { content: douyinImagePlannerRepairSystemPrompt(), role: 'system' },
            {
              content: JSON.stringify({
                douyin_image_plan_repair_input: {
                  invalid_output: initialContent ?? '',
                  original_input: plannerInput,
                  validation_error: initialFailure,
                },
              }),
              role: 'user',
            },
          ],
          requestId: `${input.requestId}:douyin:repair`,
          responseFormat: { type: 'json_object' },
          ...(input.signal ? { signal: input.signal } : {}),
          temperature: 0,
        });
        await this.recordUsage(input.scope, repaired.usage);
        repairContent = repaired.message.content;
      } catch (repairError) {
        return fallbackDouyinPlan(combinedPlannerFailure(initialFailure, safeError(repairError)), {
          attempts: 2,
          initialResponse: initialDiagnostic,
          repairResponse: null,
          repaired: false,
        });
      }
      try {
        const visuals = parseDouyinVisualPlan(repairContent, input.cards);
        return Object.freeze({
          plannerDiagnostics: Object.freeze({
            attempts: 2,
            initialResponse: initialDiagnostic,
            repairResponse: responseDiagnostic(repairContent, null),
            repaired: true,
          }),
          plannerFailure: null,
          source: 'deepseek',
          visuals,
        });
      } catch (repairError) {
        const repairFailure = safeError(repairError);
        return fallbackDouyinPlan(combinedPlannerFailure(initialFailure, repairFailure), {
          attempts: 2,
          initialResponse: initialDiagnostic,
          repairResponse: responseDiagnostic(repairContent, repairFailure),
          repaired: false,
        });
      }
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

The Chinese captions describe the illustrations and must not add facts.

Return one JSON object with exactly these top-level keys and no wrapper keys:
{
  "cover_label": "Chinese label between 2 and 24 characters",
  "scenes": [
    {
      "caption": "Chinese caption between 2 and 80 characters",
      "prompt": "English image prompt between 20 and 1600 characters"
    },
    {
      "caption": "Chinese caption between 2 and 80 characters",
      "prompt": "English image prompt between 20 and 1600 characters"
    }
  ]
}

The scenes array must contain exactly two objects. Return JSON only, without Markdown fences or commentary.`;
}

function imagePlannerRepairSystemPrompt(): string {
  return `${imagePlannerSystemPrompt()}

The previous response failed deterministic local validation. Correct its JSON structure and fields using the supplied original input and validation error. Do not relax any rule, add facts, or copy unsafe names or contact details from the invalid output.`;
}

function douyinImagePlannerSystemPrompt(): string {
  return `Create a visual plan for a Chinese Douyin image-note. The supplied card copy has already passed factual quality checks. Select three to five cards that benefit most from an illustration, always including the cover and never including the summary card.

For each selected card, create one visually distinct English prompt. The image is a background; Chinese text is added later by the server.

Hard rules:
- use a polished, high-detail commercial editorial illustration with strong depth, lighting and composition, but keep it visibly stylized rather than documentary photography;
- use anonymous people, generic moving vehicles, boxes, homes, offices, factories or equipment only when directly relevant to that card;
- no company or brand names, logos, branded uniforms, advertising, identifiable premises, licence plates or real customer cases;
- no readable text, letters, numbers, prices, phone numbers, URLs, QR codes or watermarks;
- do not depict certificates, awards, rankings, guaranteed outcomes or evidence of a real enterprise capability;
- each scene must represent that card's exact decision point or action and must differ meaningfully from every other scene;
- compose vertically for a 3:4 social-media card. For the cover, keep the lower third calm enough for a title overlay. For body cards, keep the upper half visually clear and the lower half suitable for a white text panel.

The Chinese caption only describes the illustration and must not add facts.

Return exactly one JSON object:
{
  "visuals": [
    {
      "card_key": "an existing selected card_key",
      "caption": "Chinese illustration description, 2-80 characters",
      "prompt": "English image prompt, 20-1500 characters"
    }
  ]
}

Return JSON only. Do not select the summary card and do not invent new cards.`;
}

function douyinImagePlannerRepairSystemPrompt(): string {
  return `${douyinImagePlannerSystemPrompt()}

The previous response failed deterministic validation. Correct only its structure, card selection and unsafe fields using the original input and validation error. Do not relax a rule or add facts.`;
}

function parseDouyinVisualPlan(
  value: string | undefined,
  cards: readonly DouyinImageNotePlanningCard[],
): readonly DouyinImageNoteVisual[] {
  if (!value) throw new Error('Douyin visual plan is empty');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Douyin visual plan JSON is invalid');
  }
  if (
    !record(parsed) ||
    Object.keys(parsed).some((key) => key !== 'visuals') ||
    !Array.isArray(parsed['visuals']) ||
    parsed['visuals'].length < 3 ||
    parsed['visuals'].length > Math.min(5, cards.length - 1)
  ) {
    throw new Error('Douyin visual plan shape is invalid');
  }
  const allowedCards = new Map(cards.map((card) => [card.cardKey, card]));
  const visuals = parsed['visuals'].map((item): DouyinImageNoteVisual => {
    if (
      !record(item) ||
      Object.keys(item).some((key) => !['caption', 'card_key', 'prompt'].includes(key))
    ) {
      throw new Error('Douyin visual plan item is invalid');
    }
    const cardKey = string(item['card_key']).trim();
    const caption = string(item['caption']).trim();
    const prompt = string(item['prompt']).trim();
    const card = allowedCards.get(cardKey);
    const forbidden = `${caption}\n${prompt}`;
    if (
      !card ||
      card.kind === 'summary' ||
      caption.length < 2 ||
      caption.length > 80 ||
      prompt.length < 20 ||
      prompt.length > 1_500 ||
      findDisallowedCompanyNames(forbidden).length > 0 ||
      /https?:\/\/|www\.|\b1[3-9]\d{9}\b|[¥￥$€£]|二维码|QR\s*code/iu.test(forbidden)
    ) {
      throw new Error('Douyin visual plan violates the deterministic prompt gate');
    }
    const composition =
      card.kind === 'cover'
        ? 'vertical 3:4 composition, main subject in the upper two thirds, calm darker lower third reserved for a large title overlay'
        : 'vertical 3:4 composition, main subject in the upper half, uncluttered lower half reserved for a white editorial text panel';
    const hardenedPrompt = `${prompt}. ${composition}. Premium modern editorial illustration, layered spatial depth, cohesive color palette, expressive but anonymous figures, visibly stylized and not documentary evidence, generic unbranded setting, blank unlabeled surfaces, no readable text, letters, numbers, logo, watermark, phone number, URL, QR code or licence plate, no identifiable company.`;
    if (hardenedPrompt.length > 2_048) {
      throw new Error('Hardened Douyin visual prompt is too long');
    }
    return Object.freeze({ caption, cardKey, prompt: hardenedPrompt });
  });
  if (
    new Set(visuals.map((visual) => visual.cardKey)).size !== visuals.length ||
    !visuals.some((visual) => allowedCards.get(visual.cardKey)?.kind === 'cover')
  ) {
    throw new Error('Douyin visual plan card selection is invalid');
  }
  return Object.freeze(visuals);
}

function fallbackDouyinPlan(
  plannerFailure: string,
  plannerDiagnostics: ArticleImagePlannerDiagnostics,
): DouyinImageNoteVisualPlan {
  return Object.freeze({
    plannerDiagnostics: Object.freeze(plannerDiagnostics),
    plannerFailure,
    source: 'template',
    visuals: Object.freeze([]),
  });
}

function parsePlan(
  value: string | undefined,
): Omit<ArticleImagePlan, 'plannerDiagnostics' | 'plannerFailure' | 'source'> {
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
    /https?:\/\/|www\.|\b1[3-9]\d{9}\b|[¥￥$€£]|二维码|QR\s*code/iu.test(forbidden)
  ) {
    throw new Error('Image scene violates the deterministic prompt gate');
  }
  const hardenedPrompt = `${prompt}. Flat vector editorial illustration with visibly stylized two-dimensional geometric shapes, simplified faceless figures, matte color blocks, blank unlabeled surfaces, generic unbranded setting, no photorealism, no camera-like lighting, no realistic human faces, no text, letters, or numbers, no logo or watermark, no phone number, URL, QR code, or licence plate, no identifiable company; not documentary evidence.`;
  if (hardenedPrompt.length > 2_048) throw new Error('Hardened image prompt is too long');
  return Object.freeze({ caption, prompt: hardenedPrompt });
}

function fallbackPlan(
  title: string,
  headings: readonly string[],
  plannerFailure: string,
  plannerDiagnostics: ArticleImagePlannerDiagnostics,
): ArticleImagePlan {
  const label = safeFallbackText(headings[0] || '实用指南', '实用指南', 24);
  const safeTitle = safeFallbackText(title, '内容指南', 60);
  return Object.freeze({
    coverLabel: label,
    plannerDiagnostics: Object.freeze(plannerDiagnostics),
    plannerFailure,
    scenes: Object.freeze([
      Object.freeze({ caption: `${safeTitle}准备事项示意`, prompt: '' }),
      Object.freeze({ caption: `${safeTitle}核对步骤示意`, prompt: '' }),
    ]) as readonly [ArticleImageScene, ArticleImageScene],
    source: 'template',
  });
}

function responseDiagnostic(
  value: string | undefined,
  failure: string | null,
): ArticleImagePlannerResponseDiagnostic {
  const response = value ?? '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    parsed = null;
  }
  const topLevelKeys = record(parsed) ? Object.keys(parsed).sort() : [];
  const sceneCount = record(parsed)
    ? Array.isArray(parsed['scenes'])
      ? parsed['scenes'].length
      : Array.isArray(parsed['visuals'])
        ? parsed['visuals'].length
        : null
    : null;
  return Object.freeze({
    failure,
    responseCharacters: Array.from(response).length,
    responseHash: createHash('sha256').update(response).digest('hex'),
    responsePreview: safeResponsePreview(response),
    sceneCount,
    topLevelKeys: Object.freeze(topLevelKeys),
  });
}

function safeResponsePreview(value: string): string {
  let preview = Array.from(value).slice(0, 2_000).join('');
  for (const company of findDisallowedCompanyNames(preview)) {
    preview = preview.replaceAll(company, '某公司');
  }
  return preview
    .replace(/https?:\/\/\S+|www\.\S+/giu, '[URL]')
    .replace(/\b1[3-9]\d{9}\b/gu, '[PHONE]')
    .replace(
      /\b(api[_-]?key|authorization|password|secret|token)\b\s*["']?\s*[:=]\s*["']?[^\s,"'}]+/giu,
      '$1=[REDACTED]',
    );
}

function combinedPlannerFailure(initialFailure: string, repairFailure: string): string {
  return `Initial image plan failed: ${initialFailure}; repair failed: ${repairFailure}`;
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
