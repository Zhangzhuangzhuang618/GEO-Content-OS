import {
  MODEL_ADAPTER_VERSION,
  type JsonObject,
  type ModelAdapter,
  type ModelCapabilities,
  type ModelEstimate,
  type ModelFinishReason,
  type ModelMessage,
  type ModelRequest,
  type ModelResponseFormat,
  type ModelResult,
  type ModelStreamEvent,
  type ModelToolCall,
  type ModelToolChoice,
  type ModelToolDefinition,
  type ModelUsage,
} from '@geo-content-os/adapter-model';

import {
  assertDeepSeekAdapterConfiguration,
  deepSeekCapabilities,
  type DeepSeekAdapterConfiguration,
} from './deepseek.config.js';
import { DeepSeekAdapterError } from './deepseek.errors.js';

interface ResponseLease {
  readonly dispose: () => void;
  readonly isTimedOut: () => boolean;
  readonly response: Response;
  readonly startedAt: number;
}

interface ProviderUsage {
  readonly completion_tokens: number;
  readonly prompt_tokens: number;
  readonly total_tokens: number;
}

interface ToolAccumulator {
  argumentsText: string;
  id: string;
  name: string;
}

export class DeepSeekModelAdapter implements ModelAdapter {
  public readonly modelKey: string;
  private readonly configuredCapabilities: ModelCapabilities;
  private readonly endpoint: string;

  public constructor(private readonly configuration: DeepSeekAdapterConfiguration) {
    assertDeepSeekAdapterConfiguration(configuration);
    this.modelKey = configuration.modelKey;
    this.configuredCapabilities = deepSeekCapabilities(configuration);
    this.endpoint = new URL(
      'chat/completions',
      configuration.baseUrl.endsWith('/') ? configuration.baseUrl : `${configuration.baseUrl}/`,
    ).toString();
  }

  public capabilities(): ModelCapabilities {
    return this.configuredCapabilities;
  }

  public estimate(input: ModelRequest): ModelEstimate {
    this.validateRequest(input);
    return Object.freeze({
      estimatedInputTokens: approximateTokens(JSON.stringify(this.requestBody(input, false))),
      maximumOutputTokens: input.maxOutputTokens,
      modelKey: this.modelKey,
    });
  }

  public async generate(input: ModelRequest): Promise<ModelResult> {
    this.validateRequest(input);
    const body = this.requestBody(input, false);
    for (let attempt = 0; attempt <= this.configuration.maxRetries; attempt += 1) {
      const lease = await this.openResponse(body, input.signal);
      try {
        const value: unknown = await lease.response.json();
        return this.parseCompletion(value, input, lease.startedAt);
      } catch (error) {
        const mapped =
          error instanceof DeepSeekAdapterError
            ? error
            : this.transportError(error, input.signal, lease.isTimedOut());
        if (!retryableEmptyResponse(mapped)) {
          throw mapped;
        }
        if (attempt === this.configuration.maxRetries) {
          throw new DeepSeekAdapterError(
            'DEEPSEEK_RESPONSE_INVALID',
            `DeepSeek response remained empty after ${attempt + 1} attempt(s); ${mapped.message}`,
            false,
            mapped.httpStatus,
            { cause: mapped },
          );
        }
      } finally {
        lease.dispose();
      }
      await delay(this.configuration.retryBaseDelayMs * 2 ** attempt, input.signal);
    }
    throw new DeepSeekAdapterError(
      'DEEPSEEK_RESPONSE_INVALID',
      'DeepSeek response is empty',
      false,
    );
  }

  public async *stream(input: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.validateRequest(input);
    const lease = await this.openResponse(this.requestBody(input, true), input.signal);
    const body = lease.response.body;
    if (body === null) {
      lease.dispose();
      throw new DeepSeekAdapterError(
        'DEEPSEEK_RESPONSE_INVALID',
        'DeepSeek streaming response has no body',
        false,
      );
    }

    const decoder = new TextDecoder();
    const reader = body.getReader();
    const tools = new Map<number, ToolAccumulator>();
    let buffer = '';
    let content = '';
    let finishReason: ModelFinishReason | undefined;
    let providerRequestId: string | undefined;
    let providerModelId: string | undefined;
    let usage: ProviderUsage | undefined;
    let done = false;
    try {
      while (!done) {
        const part = await reader.read();
        buffer += decoder.decode(part.value, { stream: !part.done });
        const events = buffer.replace(/\r\n/gu, '\n').split('\n\n');
        buffer = part.done ? '' : (events.pop() ?? '');
        for (const event of events) {
          const data = event
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          if (data === '[DONE]') {
            done = true;
            break;
          }
          const chunk = parseJson(data);
          const parsed = parseStreamChunk(chunk, tools);
          providerRequestId = parsed.id ?? providerRequestId;
          providerModelId = parsed.model ?? providerModelId;
          usage = parsed.usage ?? usage;
          finishReason = parsed.finishReason ?? finishReason;
          if (parsed.content) {
            content += parsed.content;
            yield Object.freeze({ delta: parsed.content, type: 'text_delta' as const });
          }
        }
        if (part.done) break;
      }
      if (!done || !providerRequestId || !providerModelId || !usage || !finishReason) {
        throw new DeepSeekAdapterError(
          'DEEPSEEK_RESPONSE_INVALID',
          'DeepSeek streaming response is incomplete',
          false,
        );
      }
      const toolCalls = Object.freeze(
        [...tools.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, value]) => parseToolCall(value)),
      );
      for (const toolCall of toolCalls) {
        yield Object.freeze({ toolCall, type: 'tool_call' as const });
      }
      const result = this.result(
        input,
        content,
        toolCalls,
        finishReason,
        providerRequestId,
        providerModelId,
        usage,
        lease.startedAt,
      );
      yield Object.freeze({ result, type: 'done' as const });
    } catch (error) {
      if (error instanceof DeepSeekAdapterError) throw error;
      throw this.transportError(error, input.signal, lease.isTimedOut());
    } finally {
      await reader.cancel().catch(() => undefined);
      lease.dispose();
    }
  }

  private validateRequest(input: ModelRequest): void {
    if (
      !identifier(input.requestId, 200) ||
      input.messages.length === 0 ||
      !Number.isSafeInteger(input.maxOutputTokens) ||
      input.maxOutputTokens < 1 ||
      input.maxOutputTokens > this.configuration.maxOutputTokens ||
      (input.temperature !== undefined &&
        (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2))
    ) {
      throw new DeepSeekAdapterError(
        'DEEPSEEK_INVALID_REQUEST',
        'DeepSeek model request is invalid',
        false,
      );
    }
    if (input.responseFormat?.type === 'json_schema') {
      throw new DeepSeekAdapterError(
        'DEEPSEEK_CAPABILITY_UNAVAILABLE',
        'Configured DeepSeek protocol does not support JSON Schema response format',
        false,
      );
    }
    for (const value of input.messages) {
      if (
        ('content' in value && value.content !== undefined && !value.content.trim()) ||
        (value.role === 'tool' && !identifier(value.toolCallId, 200))
      ) {
        throw new DeepSeekAdapterError(
          'DEEPSEEK_INVALID_REQUEST',
          'DeepSeek message is invalid',
          false,
        );
      }
    }
    const names = new Set<string>();
    for (const tool of input.tools ?? []) {
      if (
        !identifier(tool.name, 64) ||
        !tool.description.trim() ||
        names.has(tool.name) ||
        !isJsonObject(tool.inputSchema)
      ) {
        throw new DeepSeekAdapterError(
          'DEEPSEEK_INVALID_REQUEST',
          'DeepSeek tool definition is invalid',
          false,
        );
      }
      names.add(tool.name);
    }
    if (input.toolChoice !== undefined && input.tools?.length === 0) {
      throw new DeepSeekAdapterError(
        'DEEPSEEK_INVALID_REQUEST',
        'DeepSeek tool choice requires registered tools',
        false,
      );
    }
    if (typeof input.toolChoice === 'object' && !names.has(input.toolChoice.name)) {
      throw new DeepSeekAdapterError(
        'DEEPSEEK_INVALID_REQUEST',
        'Selected DeepSeek tool is not registered',
        false,
      );
    }
    if (input.signal?.aborted) throw cancelled(input.signal.reason);
  }

  private requestBody(input: ModelRequest, stream: boolean): JsonObject {
    return {
      max_tokens: input.maxOutputTokens,
      messages: input.messages.map(message),
      model: this.configuration.providerModelId,
      ...(input.responseFormat ? { response_format: responseFormat(input.responseFormat) } : {}),
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
      ...(input.toolChoice === undefined ? {} : { tool_choice: toolChoice(input.toolChoice) }),
      ...(input.tools?.length ? { tools: input.tools.map(tool) } : {}),
    };
  }

  private async openResponse(body: JsonObject, signal?: AbortSignal): Promise<ResponseLease> {
    const startedAt = performance.now();
    for (let attempt = 0; attempt <= this.configuration.maxRetries; attempt += 1) {
      const controller = new AbortController();
      let timedOut = false;
      const cancel = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', cancel, { once: true });
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('DeepSeek timeout'));
      }, this.configuration.timeoutMs);
      const dispose = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', cancel);
      };
      try {
        if (signal?.aborted) throw cancelled(signal.reason);
        const response = await fetch(this.endpoint, {
          body: JSON.stringify(body),
          headers: {
            Accept: body.stream === true ? 'text/event-stream' : 'application/json',
            Authorization: `Bearer ${this.configuration.apiKey}`,
            'Content-Type': 'application/json',
          },
          method: 'POST',
          signal: controller.signal,
        });
        if (response.ok) return { dispose, isTimedOut: () => timedOut, response, startedAt };
        const error = httpError(response.status);
        dispose();
        await response.body?.cancel().catch(() => undefined);
        if (!error.retryable || attempt === this.configuration.maxRetries) throw error;
        await retryDelay(response, this.configuration.retryBaseDelayMs, attempt, signal);
      } catch (error) {
        dispose();
        const mapped =
          error instanceof DeepSeekAdapterError
            ? error
            : signal?.aborted
              ? cancelled(signal.reason)
              : timedOut
                ? new DeepSeekAdapterError(
                    'DEEPSEEK_TIMEOUT',
                    'DeepSeek request exceeded the configured timeout',
                    true,
                    null,
                    { cause: error },
                  )
                : new DeepSeekAdapterError(
                    'DEEPSEEK_PROVIDER_FAILED',
                    'DeepSeek provider request failed',
                    true,
                    null,
                    { cause: error },
                  );
        if (!mapped.retryable || attempt === this.configuration.maxRetries) throw mapped;
        await delay(this.configuration.retryBaseDelayMs * 2 ** attempt, signal);
      }
    }
    throw new DeepSeekAdapterError('DEEPSEEK_PROVIDER_FAILED', 'DeepSeek request failed', true);
  }

  private parseCompletion(value: unknown, input: ModelRequest, startedAt: number): ModelResult {
    const root = object(value);
    const choices = array(root.choices);
    const choice = object(choices[0]);
    const providerRequestId = string(root.id);
    const providerModelId = string(root.model);
    const finishReason = mapFinishReason(string(choice.finish_reason));
    const providerMessage = object(choice.message);
    const content = nullableString(providerMessage.content) ?? '';
    const toolCalls = Object.freeze(array(providerMessage.tool_calls ?? []).map(providerToolCall));
    return this.result(
      input,
      content,
      toolCalls,
      finishReason,
      providerRequestId,
      providerModelId,
      providerUsage(root.usage),
      startedAt,
    );
  }

  private result(
    input: ModelRequest,
    content: string,
    toolCalls: readonly ModelToolCall[],
    finishReason: ModelFinishReason,
    providerRequestId: string,
    providerModelId: string,
    usage: ProviderUsage,
    startedAt: number,
  ): ModelResult {
    if (!content && toolCalls.length === 0) {
      throw new DeepSeekAdapterError(
        'DEEPSEEK_RESPONSE_INVALID',
        `DeepSeek response is empty (finish_reason=${finishReason}, output_tokens=${usage.completion_tokens})`,
        true,
      );
    }
    // JSON syntax and schema validation belong to SkillRunner. Returning the provider text here
    // allows its single repair pass to correct malformed JSON instead of failing prematurely in
    // the transport adapter.
    const registered = new Set((input.tools ?? []).map((item) => item.name));
    if (toolCalls.some((call) => !registered.has(call.name))) {
      invalidResponse('DeepSeek response called an unregistered tool');
    }
    const modelUsage: ModelUsage = Object.freeze({
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      inputTokens: usage.prompt_tokens,
      modelKey: this.modelKey,
      outputTokens: usage.completion_tokens,
      providerCode: 'deepseek',
      providerModelId,
      providerRequestId,
      totalTokens: usage.total_tokens,
    });
    return Object.freeze({
      adapterVersion: MODEL_ADAPTER_VERSION,
      finishReason,
      message: Object.freeze({
        ...(content ? { content } : {}),
        role: 'assistant' as const,
        ...(toolCalls.length ? { toolCalls: Object.freeze(toolCalls) } : {}),
      }),
      usage: modelUsage,
    });
  }

  private transportError(error: unknown, signal: AbortSignal | undefined, timedOut: boolean) {
    if (signal?.aborted) return cancelled(signal.reason);
    return timedOut
      ? new DeepSeekAdapterError(
          'DEEPSEEK_TIMEOUT',
          'DeepSeek response exceeded the configured timeout',
          true,
          null,
          { cause: error },
        )
      : new DeepSeekAdapterError(
          'DEEPSEEK_RESPONSE_INVALID',
          'DeepSeek response could not be read',
          false,
          null,
          { cause: error },
        );
  }
}

function message(value: ModelMessage): JsonObject {
  if (value.role === 'tool') {
    return { content: value.content, role: value.role, tool_call_id: value.toolCallId };
  }
  if (value.role === 'assistant') {
    return {
      content: value.content ?? null,
      role: value.role,
      ...(value.toolCalls?.length
        ? {
            tool_calls: value.toolCalls.map((call) => ({
              function: { arguments: JSON.stringify(call.arguments), name: call.name },
              id: call.id,
              type: 'function',
            })),
          }
        : {}),
    };
  }
  return { content: value.content, role: value.role };
}

function tool(value: ModelToolDefinition): JsonObject {
  return {
    function: {
      description: value.description,
      name: value.name,
      parameters: value.inputSchema,
    },
    type: 'function',
  };
}

function toolChoice(value: ModelToolChoice): JsonObject | string {
  return typeof value === 'string' ? value : { function: { name: value.name }, type: 'function' };
}

function responseFormat(value: ModelResponseFormat): JsonObject {
  if (value.type === 'json_schema') {
    throw new DeepSeekAdapterError(
      'DEEPSEEK_CAPABILITY_UNAVAILABLE',
      'DeepSeek JSON Schema response format is unavailable',
      false,
    );
  }
  return { type: value.type };
}

function providerToolCall(value: unknown): ModelToolCall {
  const root = object(value);
  const callable = object(root.function);
  return parseToolCall({
    argumentsText: string(callable.arguments),
    id: string(root.id),
    name: string(callable.name),
  });
}

function parseToolCall(value: ToolAccumulator): ModelToolCall {
  const argumentsValue = parseJson(value.argumentsText);
  if (!identifier(value.id, 200) || !identifier(value.name, 64) || !isJsonObject(argumentsValue)) {
    invalidResponse('DeepSeek tool call is invalid');
  }
  return Object.freeze({ arguments: argumentsValue, id: value.id, name: value.name });
}

function parseStreamChunk(
  value: unknown,
  tools: Map<number, ToolAccumulator>,
): {
  readonly content?: string;
  readonly finishReason?: ModelFinishReason;
  readonly id?: string;
  readonly model?: string;
  readonly usage?: ProviderUsage;
} {
  const root = object(value);
  const parsedUsage =
    root.usage === null || root.usage === undefined ? undefined : providerUsage(root.usage);
  const choices = array(root.choices);
  if (choices.length === 0) return parsedUsage ? { usage: parsedUsage } : {};
  const choice = object(choices[0]);
  const delta = object(choice.delta);
  for (const item of array(delta.tool_calls ?? [])) {
    const toolDelta = object(item);
    const index = integer(toolDelta.index);
    const callable = object(toolDelta.function ?? {});
    const current = tools.get(index) ?? { argumentsText: '', id: '', name: '' };
    current.id ||= nullableString(toolDelta.id) ?? '';
    current.name ||= nullableString(callable.name) ?? '';
    current.argumentsText += nullableString(callable.arguments) ?? '';
    tools.set(index, current);
  }
  const content = nullableString(delta.content);
  return {
    ...(content === null ? {} : { content }),
    ...(choice.finish_reason === null || choice.finish_reason === undefined
      ? {}
      : { finishReason: mapFinishReason(string(choice.finish_reason)) }),
    id: string(root.id),
    model: string(root.model),
    ...(parsedUsage ? { usage: parsedUsage } : {}),
  };
}

function providerUsage(value: unknown): ProviderUsage {
  const root = object(value);
  const usage = {
    completion_tokens: integer(root.completion_tokens),
    prompt_tokens: integer(root.prompt_tokens),
    total_tokens: integer(root.total_tokens),
  };
  if (
    usage.completion_tokens < 0 ||
    usage.prompt_tokens < 0 ||
    usage.total_tokens !== usage.completion_tokens + usage.prompt_tokens
  ) {
    invalidResponse('DeepSeek usage is invalid');
  }
  return usage;
}

function mapFinishReason(value: string): ModelFinishReason {
  if (
    value === 'stop' ||
    value === 'length' ||
    value === 'content_filter' ||
    value === 'tool_calls'
  ) {
    return value;
  }
  if (value === 'insufficient_system_resource') {
    throw new DeepSeekAdapterError(
      'DEEPSEEK_PROVIDER_FAILED',
      'DeepSeek stopped because provider resources were unavailable',
      true,
    );
  }
  return 'unknown';
}

function httpError(status: number): DeepSeekAdapterError {
  if (status === 401 || status === 403) {
    return new DeepSeekAdapterError(
      'DEEPSEEK_AUTH_FAILED',
      'DeepSeek authentication failed',
      false,
      status,
    );
  }
  if (status === 429) {
    return new DeepSeekAdapterError(
      'DEEPSEEK_RATE_LIMITED',
      'DeepSeek rate limit exceeded',
      true,
      status,
    );
  }
  return new DeepSeekAdapterError(
    'DEEPSEEK_PROVIDER_FAILED',
    'DeepSeek provider returned an unsuccessful response',
    status === 408 || status >= 500,
    status,
  );
}

async function retryDelay(
  response: Response,
  baseDelayMs: number,
  attempt: number,
  signal?: AbortSignal,
): Promise<void> {
  const retryAfter = response.headers.get('retry-after');
  const seconds = retryAfter && /^\d+$/u.test(retryAfter) ? Number(retryAfter) : null;
  await delay(
    seconds === null ? baseDelayMs * 2 ** attempt : Math.min(seconds * 1000, 30_000),
    signal,
  );
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelled(signal.reason));
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(cancelled(signal?.reason));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function cancelled(cause?: unknown): DeepSeekAdapterError {
  return new DeepSeekAdapterError(
    'DEEPSEEK_CANCELLED',
    'DeepSeek request was cancelled',
    false,
    null,
    { cause },
  );
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new DeepSeekAdapterError(
      'DEEPSEEK_RESPONSE_INVALID',
      'DeepSeek returned invalid JSON',
      false,
      null,
      { cause: error },
    );
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidResponse('DeepSeek response object is invalid');
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) invalidResponse('DeepSeek response array is invalid');
  return value;
}

function string(value: unknown): string {
  if (typeof value !== 'string' || !value) invalidResponse('DeepSeek response string is invalid');
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') invalidResponse('DeepSeek response string is invalid');
  return value;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value)) invalidResponse('DeepSeek response integer is invalid');
  return value as number;
}

function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isJsonValue)
  );
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

function identifier(value: string, maximum: number): boolean {
  return value.length <= maximum && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value);
}

function approximateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function invalidResponse(message: string): never {
  throw new DeepSeekAdapterError('DEEPSEEK_RESPONSE_INVALID', message, false);
}

function retryableEmptyResponse(error: DeepSeekAdapterError): boolean {
  return error.code === 'DEEPSEEK_RESPONSE_INVALID' && error.retryable;
}
