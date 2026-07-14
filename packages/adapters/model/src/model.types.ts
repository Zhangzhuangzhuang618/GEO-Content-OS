export const MODEL_ADAPTER_VERSION = 'model-adapter/1.0.0' as const;

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type ModelMessage =
  | { readonly content: string; readonly role: 'system' | 'user' }
  | {
      readonly content?: string;
      readonly role: 'assistant';
      readonly toolCalls?: readonly ModelToolCall[];
    }
  | { readonly content: string; readonly role: 'tool'; readonly toolCallId: string };

export interface ModelToolDefinition {
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly name: string;
}

export interface ModelToolCall {
  readonly arguments: JsonObject;
  readonly id: string;
  readonly name: string;
}

export type ModelToolChoice = 'auto' | 'none' | 'required' | { readonly name: string };

export type ModelResponseFormat =
  | { readonly type: 'text' }
  | { readonly type: 'json_object' }
  | {
      readonly name: string;
      readonly schema: JsonObject;
      readonly strict: boolean;
      readonly type: 'json_schema';
    };

export interface ModelRequest {
  readonly maxOutputTokens: number;
  readonly messages: readonly ModelMessage[];
  readonly requestId: string;
  readonly responseFormat?: ModelResponseFormat;
  readonly signal?: AbortSignal;
  readonly temperature?: number;
  readonly toolChoice?: ModelToolChoice;
  readonly tools?: readonly ModelToolDefinition[];
}

export interface ModelCapabilities {
  readonly jsonMode: boolean;
  readonly jsonSchema: boolean;
  readonly maxOutputTokens: number;
  readonly streaming: boolean;
  readonly toolCalling: boolean;
}

export interface ModelEstimate {
  readonly estimatedInputTokens: number;
  readonly maximumOutputTokens: number;
  readonly modelKey: string;
}

export interface ModelUsage {
  readonly durationMs: number;
  readonly inputTokens: number;
  readonly modelKey: string;
  readonly outputTokens: number;
  readonly providerCode: string;
  readonly providerModelId: string;
  readonly providerRequestId: string;
  readonly totalTokens: number;
}

export type ModelFinishReason = 'content_filter' | 'length' | 'stop' | 'tool_calls' | 'unknown';

export interface ModelResult {
  readonly adapterVersion: typeof MODEL_ADAPTER_VERSION;
  readonly finishReason: ModelFinishReason;
  readonly message: Extract<ModelMessage, { readonly role: 'assistant' }>;
  readonly usage: ModelUsage;
}

export type ModelStreamEvent =
  | { readonly delta: string; readonly type: 'text_delta' }
  | { readonly toolCall: ModelToolCall; readonly type: 'tool_call' }
  | { readonly result: ModelResult; readonly type: 'done' };

export interface ModelAdapter {
  readonly modelKey: string;
  capabilities(): ModelCapabilities;
  estimate(input: ModelRequest): ModelEstimate;
  generate(input: ModelRequest): Promise<ModelResult>;
  stream(input: ModelRequest): AsyncIterable<ModelStreamEvent>;
}
