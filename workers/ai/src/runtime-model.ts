import {
  MODEL_ADAPTER_VERSION,
  type JsonObject as ModelJsonObject,
  type ModelAdapter,
  type ModelCapabilities,
  type ModelEstimate,
  type ModelRequest,
  type ModelResult,
  type ModelStreamEvent,
} from '@geo-content-os/adapter-model';
import {
  DeepSeekModelAdapter,
  loadDeepSeekAdapterConfiguration,
} from '@geo-content-os/adapter-model-deepseek';

import type { AiModelDriver } from './config.js';

export function createRuntimeModels(
  driver: AiModelDriver,
  environment = process.env,
): ReadonlyMap<string, ModelAdapter> {
  const keys = new Set([
    environment['CONTENT_MODEL_FAST_KEY'] ?? 'deepseek-v4-flash',
    environment['CONTENT_MODEL_BALANCED_KEY'] ?? 'deepseek-v4-flash',
    environment['CONTENT_MODEL_QUALITY_KEY'] ?? 'deepseek-v4-pro',
    environment['QUALITY_CHECKER_MODEL_KEY'] ?? 'deepseek-v4-flash',
    environment['VISIBILITY_MODEL_KEY'] ??
      environment['CONTENT_MODEL_BALANCED_KEY'] ??
      'deepseek-v4-flash',
  ]);
  return new Map(
    [...keys].map((key) => [
      key,
      driver === 'deepseek'
        ? new DeepSeekModelAdapter(
            loadDeepSeekAdapterConfiguration({
              DEEPSEEK_API_KEY: environment['DEEPSEEK_API_KEY'],
              DEEPSEEK_BASE_URL: environment['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com/v1',
              DEEPSEEK_MAX_OUTPUT_TOKENS: environment['DEEPSEEK_MAX_OUTPUT_TOKENS'] ?? '32768',
              DEEPSEEK_MAX_RETRIES: environment['DEEPSEEK_MAX_RETRIES'] ?? '2',
              DEEPSEEK_MODEL_KEY: key,
              DEEPSEEK_PROVIDER_MODEL_ID: providerModelId(key, environment),
              DEEPSEEK_RETRY_BASE_DELAY_MS: environment['DEEPSEEK_RETRY_BASE_DELAY_MS'] ?? '500',
              DEEPSEEK_TIMEOUT_MS: environment['DEEPSEEK_TIMEOUT_MS'] ?? '120000',
            }),
          )
        : new RuntimeMockContentModel(key),
    ]),
  );
}

export function createRuntimeModel(driver: AiModelDriver, environment = process.env): ModelAdapter {
  const balanced = environment['CONTENT_MODEL_BALANCED_KEY'] ?? 'deepseek-v4-flash';
  return createRuntimeModels(driver, environment).get(balanced)!;
}

function providerModelId(modelKey: string, environment: NodeJS.ProcessEnv): string {
  if (modelKey === 'deepseek-v4-flash' || modelKey === 'deepseek-v4-pro') return modelKey;
  return environment['DEEPSEEK_PROVIDER_MODEL_ID'] ?? modelKey;
}

class RuntimeMockContentModel implements ModelAdapter {
  public constructor(public readonly modelKey: string) {}

  public capabilities(): ModelCapabilities {
    return Object.freeze({
      jsonMode: true,
      jsonSchema: true,
      maxOutputTokens: 32768,
      streaming: true,
      toolCalling: true,
    });
  }

  public estimate(input: ModelRequest): ModelEstimate {
    return Object.freeze({
      estimatedInputTokens: tokens(JSON.stringify(input.messages)),
      maximumOutputTokens: input.maxOutputTokens,
      modelKey: this.modelKey,
    });
  }

  public async generate(input: ModelRequest): Promise<ModelResult> {
    if (input.signal?.aborted) throw input.signal.reason;
    const output = mockOutput(input);
    const text = typeof output === 'string' ? output : JSON.stringify(output);
    const inputTokens = tokens(JSON.stringify(input.messages));
    const outputTokens = tokens(text);
    return Object.freeze({
      adapterVersion: MODEL_ADAPTER_VERSION,
      finishReason: 'stop',
      message: Object.freeze({ content: text, role: 'assistant' as const }),
      usage: Object.freeze({
        durationMs: 0,
        inputTokens,
        modelKey: this.modelKey,
        outputTokens,
        providerCode: 'mock',
        providerModelId: 'runtime-content-writer-v1',
        providerRequestId: `mock-${input.requestId}`,
        totalTokens: inputTokens + outputTokens,
      }),
    });
  }

  public async *stream(input: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const result = await this.generate(input);
    yield Object.freeze({ delta: result.message.content ?? '', type: 'text_delta' as const });
    yield Object.freeze({ result, type: 'done' as const });
  }
}

function mockOutput(input: ModelRequest): ModelJsonObject | string {
  const visibilityInput = optionalMessageObject(input, 'ai_visibility_query');
  if (visibilityInput) return string(visibilityInput['text']) || '未提供测试问题。';
  const qualityInput = optionalMessageObject(input, 'quality_checker_input');
  if (qualityInput) return mockQualityOutput(qualityInput);
  const writerInput = messageObject(input, 'content_writer_input');
  const brief = object(writerInput['brief']);
  const citations = array(writerInput['citations']).map(object);
  const locks = array(writerInput['locked_blocks']).map(object);
  const platformCodes = array(brief['platform_codes']).filter(
    (value): value is string => typeof value === 'string',
  );
  const content = (platformCode: string): ModelJsonObject => {
    const first = citations[0];
    const evidenceText = first
      ? string(first['quote_text'])
      : '本稿依据当前品牌策略与内容简报生成，请在发布前完成事实复核。';
    const relevantLocks = locks.filter((lock) => string(lock['platform_code']) === platformCode);
    const blocks = [
      {
        block_key: 'core_summary',
        block_type: 'paragraph',
        text: evidenceText,
      },
      ...relevantLocks.map((lock) => ({
        block_key: string(lock['block_key']),
        block_type: 'paragraph',
        text: string(lock['text']),
      })),
    ];
    const citationMap = [
      ...(first
        ? [
            {
              citation_ids: [string(first['citation_id'])],
              claim_key: 'core_summary',
              claim_text: evidenceText,
            },
          ]
        : []),
      ...relevantLocks.map((lock) => ({
        citation_ids: array(lock['citation_ids']).filter(
          (value): value is string => typeof value === 'string',
        ),
        claim_key: string(lock['block_key']),
        claim_text: string(lock['text']),
      })),
    ];
    return {
      blocks,
      citation_map: citationMap,
      cta: null,
      hashtags: [],
      platform_code: platformCode,
      platform_meta: {},
      summary: shorten(evidenceText, 120),
      title: platformTitle(string(brief['title']) || 'GEO 内容稿', platformCode),
    };
  };
  return {
    master_content: content('master'),
    variants: platformCodes.map(content),
  };
}

function mockQualityOutput(qualityInput: ModelJsonObject): ModelJsonObject {
  const geoResult = object(qualityInput['geo_result']);
  const geoScores = object(geoResult['scores']);
  return {
    decision: 'pass',
    geo_scores: geoScores,
    issues: [],
    score: typeof geoScores['total'] === 'number' ? geoScores['total'] : 80,
  };
}

function messageObject(input: ModelRequest, key: string): ModelJsonObject {
  const found = optionalMessageObject(input, key);
  if (found) return found;
  throw new Error(`Runtime mock could not find ${key}`);
}

function optionalMessageObject(input: ModelRequest, key: string): ModelJsonObject | null {
  for (const message of input.messages) {
    if (!('content' in message) || !message.content) continue;
    try {
      const parsed = JSON.parse(message.content) as unknown;
      if (isObject(parsed) && isObject(parsed[key])) return parsed[key];
    } catch {
      // Non-JSON prompt messages are expected.
    }
  }
  return null;
}

function platformTitle(title: string, platformCode: string): string {
  const maximum: Readonly<Record<string, number>> = {
    baijiahao: 40,
    official_site: 60,
    toutiao: 50,
    wechat_mp: 64,
    xiaohongshu: 20,
  };
  return shorten(title, maximum[platformCode] ?? 80);
}

function shorten(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}

function tokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function object(value: unknown): ModelJsonObject {
  return isObject(value) ? value : {};
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isObject(value: unknown): value is ModelJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
