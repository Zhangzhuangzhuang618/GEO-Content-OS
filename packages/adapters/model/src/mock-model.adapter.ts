import { ModelAdapterError } from './model.errors.js';
import {
  MODEL_ADAPTER_VERSION,
  type JsonObject,
  type ModelAdapter,
  type ModelCapabilities,
  type ModelEstimate,
  type ModelFinishReason,
  type ModelRequest,
  type ModelResult,
  type ModelStreamEvent,
  type ModelToolCall,
} from './model.types.js';

export interface MockModelResponse {
  readonly finishReason?: ModelFinishReason;
  readonly text?: string;
  readonly toolCalls?: readonly ModelToolCall[];
}

export interface MockModelAdapterOptions {
  readonly capabilities?: Partial<ModelCapabilities>;
  readonly latencyMs?: number;
  readonly modelKey?: string;
  readonly providerCode?: string;
  readonly providerModelId?: string;
  readonly responses?: readonly MockModelResponse[];
  readonly streamChunkSize?: number;
}

const DEFAULT_CAPABILITIES: ModelCapabilities = Object.freeze({
  jsonMode: true,
  jsonSchema: true,
  maxOutputTokens: 8192,
  streaming: true,
  toolCalling: true,
});

export class MockModelAdapter implements ModelAdapter {
  public readonly modelKey: string;
  private readonly configuredCapabilities: ModelCapabilities;
  private callCount = 0;

  public constructor(private readonly options: MockModelAdapterOptions = {}) {
    this.modelKey = options.modelKey ?? 'mock';
    this.configuredCapabilities = Object.freeze({
      ...DEFAULT_CAPABILITIES,
      ...options.capabilities,
    });
    requireIdentifier(this.modelKey, 'model key');
    requireIdentifier(options.providerCode ?? 'mock', 'provider code');
    requireIdentifier(options.providerModelId ?? 'mock-model-v1', 'provider model ID');
    if (
      !Number.isSafeInteger(this.configuredCapabilities.maxOutputTokens) ||
      this.configuredCapabilities.maxOutputTokens < 1 ||
      !Number.isSafeInteger(options.streamChunkSize ?? 16) ||
      (options.streamChunkSize ?? 16) < 1 ||
      !Number.isSafeInteger(options.latencyMs ?? 0) ||
      (options.latencyMs ?? 0) < 0
    ) {
      throw new TypeError('Mock Model Adapter configuration is invalid');
    }
  }

  public capabilities(): ModelCapabilities {
    return this.configuredCapabilities;
  }

  public estimate(input: ModelRequest): ModelEstimate {
    validateRequest(input, this.configuredCapabilities);
    return Object.freeze({
      estimatedInputTokens: approximateTokens(serializeInput(input)),
      maximumOutputTokens: input.maxOutputTokens,
      modelKey: this.modelKey,
    });
  }

  public async generate(input: ModelRequest): Promise<ModelResult> {
    validateRequest(input, this.configuredCapabilities);
    const invocation = this.takeResponse(input);
    await delay(this.options.latencyMs ?? 0, input.signal);
    return this.result(input, invocation.response, invocation.callNumber);
  }

  public async *stream(input: ModelRequest): AsyncIterable<ModelStreamEvent> {
    validateRequest(input, this.configuredCapabilities);
    if (!this.configuredCapabilities.streaming) {
      throw new ModelAdapterError(
        'MODEL_CAPABILITY_UNAVAILABLE',
        'Configured model does not support streaming',
      );
    }
    const invocation = this.takeResponse(input);
    await delay(this.options.latencyMs ?? 0, input.signal);
    const result = this.result(input, invocation.response, invocation.callNumber);
    const chunkSize = this.options.streamChunkSize ?? 16;
    for (let offset = 0; offset < (result.message.content?.length ?? 0); offset += chunkSize) {
      throwIfAborted(input.signal);
      yield Object.freeze({
        delta: result.message.content!.slice(offset, offset + chunkSize),
        type: 'text_delta' as const,
      });
    }
    for (const toolCall of result.message.toolCalls ?? []) {
      throwIfAborted(input.signal);
      yield Object.freeze({ toolCall, type: 'tool_call' as const });
    }
    throwIfAborted(input.signal);
    yield Object.freeze({ result, type: 'done' as const });
  }

  private takeResponse(input: ModelRequest): {
    readonly callNumber: number;
    readonly response: MockModelResponse;
  } {
    const callNumber = this.callCount + 1;
    const response = this.options.responses?.[this.callCount];
    this.callCount += 1;
    if (response !== undefined) return { callNumber, response };
    const text = [...input.messages].reverse().find((message) => message.role === 'user')?.content;
    return {
      callNumber,
      response:
        input.responseFormat?.type === 'json_object' || input.responseFormat?.type === 'json_schema'
          ? { text: JSON.stringify({ content: text ?? '' }) }
          : { text: text ?? '' },
    };
  }

  private result(
    input: ModelRequest,
    response: MockModelResponse,
    callNumber: number,
  ): ModelResult {
    throwIfAborted(input.signal);
    const text = response.text ?? '';
    validateResponse(input, response, text);
    const toolCalls = Object.freeze(
      (response.toolCalls ?? []).map((toolCall) =>
        Object.freeze({ ...toolCall, arguments: Object.freeze({ ...toolCall.arguments }) }),
      ),
    );
    const message = Object.freeze({
      ...(text ? { content: text } : {}),
      role: 'assistant' as const,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    });
    const inputTokens = approximateTokens(serializeInput(input));
    const outputTokens = approximateTokens(
      `${text}${toolCalls.map((call) => JSON.stringify(call)).join('')}`,
    );
    return Object.freeze({
      adapterVersion: MODEL_ADAPTER_VERSION,
      finishReason: response.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      message,
      usage: Object.freeze({
        durationMs: this.options.latencyMs ?? 0,
        inputTokens,
        modelKey: this.modelKey,
        outputTokens,
        providerCode: this.options.providerCode ?? 'mock',
        providerModelId: this.options.providerModelId ?? 'mock-model-v1',
        providerRequestId: `mock-${input.requestId}-${callNumber}`,
        totalTokens: inputTokens + outputTokens,
      }),
    });
  }
}

function validateRequest(input: ModelRequest, capabilities: ModelCapabilities): void {
  requireIdentifier(input.requestId, 'request ID');
  if (
    input.messages.length === 0 ||
    !Number.isSafeInteger(input.maxOutputTokens) ||
    input.maxOutputTokens < 1 ||
    input.maxOutputTokens > capabilities.maxOutputTokens ||
    (input.temperature !== undefined &&
      (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2))
  ) {
    throw new ModelAdapterError('MODEL_INVALID_INPUT', 'Model request is invalid');
  }
  for (const message of input.messages) {
    if (
      ('content' in message && message.content !== undefined && !message.content.trim()) ||
      (message.role === 'tool' && !message.toolCallId.trim())
    ) {
      throw new ModelAdapterError('MODEL_INVALID_INPUT', 'Model message is invalid');
    }
  }
  const format = input.responseFormat?.type ?? 'text';
  if (format === 'json_object' && !capabilities.jsonMode) unavailable('JSON mode');
  if (format === 'json_schema' && !capabilities.jsonSchema) unavailable('JSON Schema');
  if (input.responseFormat?.type === 'json_schema') {
    requireIdentifier(input.responseFormat.name, 'response schema name');
    if (!isJsonObject(input.responseFormat.schema)) {
      throw new ModelAdapterError('MODEL_INVALID_INPUT', 'Model response schema is invalid');
    }
  }
  if ((input.tools?.length ?? 0) > 0 && !capabilities.toolCalling) unavailable('tool calling');
  const names = new Set<string>();
  for (const tool of input.tools ?? []) {
    requireIdentifier(tool.name, 'tool name');
    if (!tool.description.trim() || names.has(tool.name) || !isJsonObject(tool.inputSchema)) {
      throw new ModelAdapterError('MODEL_INVALID_INPUT', 'Model tool definition is invalid');
    }
    names.add(tool.name);
  }
  if (input.toolChoice !== undefined && input.tools?.length === 0) {
    throw new ModelAdapterError('MODEL_INVALID_INPUT', 'Tool choice requires registered tools');
  }
  if (typeof input.toolChoice === 'object' && !names.has(input.toolChoice.name)) {
    throw new ModelAdapterError('MODEL_INVALID_INPUT', 'Selected tool is not registered');
  }
  throwIfAborted(input.signal);
}

function validateResponse(input: ModelRequest, response: MockModelResponse, text: string): void {
  if (!text && (response.toolCalls?.length ?? 0) === 0) {
    throw new ModelAdapterError('MODEL_RESPONSE_INVALID', 'Model response is empty');
  }
  if (
    text &&
    (input.responseFormat?.type === 'json_object' || input.responseFormat?.type === 'json_schema')
  ) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isJsonObject(parsed)) throw new Error('Expected a JSON object');
    } catch (error) {
      throw new ModelAdapterError('MODEL_RESPONSE_INVALID', 'Model response is not a JSON object', {
        cause: error,
      });
    }
  }
  const registered = new Set((input.tools ?? []).map((tool) => tool.name));
  const identifiers = new Set<string>();
  for (const call of response.toolCalls ?? []) {
    if (
      !registered.has(call.name) ||
      !call.id.trim() ||
      identifiers.has(call.id) ||
      !isJsonObject(call.arguments)
    ) {
      throw new ModelAdapterError('MODEL_RESPONSE_INVALID', 'Model tool call is invalid');
    }
    identifiers.add(call.id);
  }
  if (input.toolChoice === 'none' && (response.toolCalls?.length ?? 0) > 0) {
    throw new ModelAdapterError('MODEL_RESPONSE_INVALID', 'Model returned a forbidden tool call');
  }
  if (input.toolChoice === 'required' && (response.toolCalls?.length ?? 0) === 0) {
    throw new ModelAdapterError(
      'MODEL_RESPONSE_INVALID',
      'Model did not return a required tool call',
    );
  }
  if (typeof input.toolChoice === 'object') {
    const selectedToolName = input.toolChoice.name;
    if (!response.toolCalls?.some((call) => call.name === selectedToolName)) {
      throw new ModelAdapterError('MODEL_RESPONSE_INVALID', 'Model did not call the selected tool');
    }
  }
  if (
    response.finishReason !== undefined &&
    (response.finishReason === 'tool_calls') !== (response.toolCalls?.length ?? 0) > 0
  ) {
    throw new ModelAdapterError('MODEL_RESPONSE_INVALID', 'Model finish reason is inconsistent');
  }
}

function serializeInput(input: ModelRequest): string {
  return JSON.stringify({
    messages: input.messages,
    responseFormat: input.responseFormat,
    tools: input.tools,
  });
}

function approximateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
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

function unavailable(capability: string): never {
  throw new ModelAdapterError(
    'MODEL_CAPABILITY_UNAVAILABLE',
    `Configured model does not support ${capability}`,
  );
}

function requireIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(value)) {
    throw new ModelAdapterError('MODEL_INVALID_INPUT', `Model ${label} is invalid`);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ModelAdapterError('MODEL_CANCELLED', 'Model request was cancelled', {
      cause: signal.reason,
    });
  }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(
        new ModelAdapterError('MODEL_CANCELLED', 'Model request was cancelled', {
          cause: signal?.reason,
        }),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
