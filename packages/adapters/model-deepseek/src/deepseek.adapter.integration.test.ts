import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DeepSeekAdapterError,
  DeepSeekModelAdapter,
  loadDeepSeekAdapterConfiguration,
  type DeepSeekAdapterConfiguration,
} from './index.js';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const request = {
  maxOutputTokens: 256,
  messages: [{ content: 'Return verified facts as JSON.', role: 'user' as const }],
  requestId: 'request-00000001',
};

describe('DeepSeekModelAdapter integration', () => {
  it('identifies the invalid message without logging its content', async () => {
    const adapter = new DeepSeekModelAdapter(configuration('http://127.0.0.1:1'));

    const error = await adapter
      .generate({ ...request, messages: [{ content: '   ', role: 'user' }] })
      .catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: 'DEEPSEEK_INVALID_REQUEST', retryable: false });
    expect(String(error)).toContain('message 0 (user) has empty content');
  });

  it('accepts blank assistant content only when it carries a tool call', async () => {
    let receivedBody: Record<string, unknown> | undefined;
    const baseUrl = await serve(async (incoming, outgoing) => {
      receivedBody = JSON.parse(await body(incoming)) as Record<string, unknown>;
      json(outgoing, completion({ content: '{"answer":"verified"}' }));
    });
    const adapter = new DeepSeekModelAdapter(configuration(baseUrl));
    const toolCall = {
      arguments: { query: 'GEO' },
      id: 'call-1',
      name: 'search_knowledge',
    } as const;
    const tools = [
      {
        description: 'Search scoped knowledge',
        inputSchema: { properties: { query: { type: 'string' } }, type: 'object' },
        name: 'search_knowledge',
      },
    ] as const;

    await expect(
      adapter.generate({
        ...request,
        messages: [
          request.messages[0]!,
          { content: '   ', role: 'assistant', toolCalls: [toolCall] },
          { content: '{"facts":[]}', role: 'tool', toolCallId: toolCall.id },
        ],
        tools,
      }),
    ).resolves.toMatchObject({ message: { content: '{"answer":"verified"}' } });

    const messages = receivedBody?.['messages'] as readonly Record<string, unknown>[];
    expect(messages[1]).toMatchObject({ content: null, role: 'assistant' });
    expect(messages[1]?.['tool_calls']).toHaveLength(1);
    await expect(
      adapter.generate({
        ...request,
        messages: [{ content: '   ', role: 'assistant' }],
        tools,
      }),
    ).rejects.toMatchObject({ code: 'DEEPSEEK_INVALID_REQUEST', retryable: false });
  });

  it('loads all provider identifiers and limits from configuration', () => {
    const configuration = loadDeepSeekAdapterConfiguration({
      DEEPSEEK_API_KEY: 'test-secret',
      DEEPSEEK_BASE_URL: 'https://provider.example/v1',
      DEEPSEEK_MAX_OUTPUT_TOKENS: '4096',
      DEEPSEEK_MAX_RETRIES: '2',
      DEEPSEEK_MODEL_KEY: 'flash',
      DEEPSEEK_PROVIDER_MODEL_ID: 'configured-provider-model',
      DEEPSEEK_RETRY_BASE_DELAY_MS: '25',
      DEEPSEEK_TIMEOUT_MS: '30000',
    });

    expect(configuration).toMatchObject({
      baseUrl: 'https://provider.example/v1',
      modelKey: 'flash',
      providerModelId: 'configured-provider-model',
    });
    expect(new DeepSeekModelAdapter(configuration).capabilities()).toEqual({
      jsonMode: true,
      jsonSchema: false,
      maxOutputTokens: 4096,
      streaming: true,
      toolCalling: true,
    });
  });

  it('maps JSON mode, disables provider-default thinking, and records usage', async () => {
    let receivedBody: Record<string, unknown> | undefined;
    let authorization: string | undefined;
    const baseUrl = await serve(async (incoming, outgoing) => {
      authorization = incoming.headers.authorization;
      receivedBody = JSON.parse(await body(incoming)) as Record<string, unknown>;
      json(outgoing, completion({ content: '{"answer":"verified"}' }));
    });
    const adapter = new DeepSeekModelAdapter(configuration(baseUrl));

    const result = await adapter.generate({
      ...request,
      responseFormat: { type: 'json_object' },
      toolChoice: 'auto',
      tools: [
        {
          description: 'Search scoped knowledge',
          inputSchema: { properties: { query: { type: 'string' } }, type: 'object' },
          name: 'search_knowledge',
        },
      ],
    });

    expect(authorization).toBe('Bearer test-secret');
    expect(receivedBody).toMatchObject({
      model: 'provider-model-from-config',
      response_format: { type: 'json_object' },
      stream: false,
      thinking: { type: 'disabled' },
      tool_choice: 'auto',
    });
    expect(result.message.content).toBe('{"answer":"verified"}');
    expect(result.usage).toMatchObject({
      inputTokens: 11,
      outputTokens: 7,
      providerCode: 'deepseek',
      providerModelId: 'provider-model-response',
      providerRequestId: 'provider-request-1',
      totalTokens: 18,
    });
  });

  it('returns malformed JSON text so SkillRunner can perform its schema repair pass', async () => {
    const baseUrl = await serve((_incoming, outgoing) => {
      json(outgoing, completion({ content: '{"answer":"missing brace"' }));
    });
    const adapter = new DeepSeekModelAdapter(configuration(baseUrl));

    await expect(
      adapter.generate({ ...request, responseFormat: { type: 'json_object' } }),
    ).resolves.toMatchObject({
      message: { content: '{"answer":"missing brace"' },
    });
  });

  it('retries a rate-limited request within the configured bound', async () => {
    let attempts = 0;
    const baseUrl = await serve((_incoming, outgoing) => {
      attempts += 1;
      if (attempts === 1) {
        outgoing.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
        outgoing.end('{"error":{"message":"limited"}}');
        return;
      }
      json(outgoing, completion({ content: 'recovered' }));
    });
    const adapter = new DeepSeekModelAdapter(configuration(baseUrl, { maxRetries: 1 }));

    await expect(adapter.generate(request)).resolves.toMatchObject({ finishReason: 'stop' });
    expect(attempts).toBe(2);
  });

  it('retries an empty successful completion within the configured bound', async () => {
    let attempts = 0;
    const baseUrl = await serve((_incoming, outgoing) => {
      attempts += 1;
      json(outgoing, completion({ content: attempts === 1 ? '' : 'recovered' }));
    });
    const adapter = new DeepSeekModelAdapter(configuration(baseUrl, { maxRetries: 1 }));

    await expect(adapter.generate(request)).resolves.toMatchObject({
      message: { content: 'recovered' },
    });
    expect(attempts).toBe(2);
  });

  it('reports safe completion diagnostics after bounded empty-response retries', async () => {
    let attempts = 0;
    const baseUrl = await serve((_incoming, outgoing) => {
      attempts += 1;
      json(
        outgoing,
        completion({
          completionTokens: 256,
          content: '',
          finishReason: 'length',
          reasoningContent: 'private-reasoning-test-secret',
        }),
      );
    });
    const adapter = new DeepSeekModelAdapter(configuration(baseUrl, { maxRetries: 2 }));

    const error = await adapter.generate(request).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(DeepSeekAdapterError);
    expect(error).toMatchObject({ code: 'DEEPSEEK_RESPONSE_INVALID', retryable: false });
    expect(String(error)).toContain('after 3 attempt(s)');
    expect(String(error)).toContain('finish_reason=length');
    expect(String(error)).toContain('output_tokens=256');
    expect(String(error)).not.toContain('private-reasoning-test-secret');
    expect(attempts).toBe(3);
  });

  it('does not retry authentication failures or expose credentials', async () => {
    let attempts = 0;
    const baseUrl = await serve((_incoming, outgoing) => {
      attempts += 1;
      outgoing.writeHead(401, { 'Content-Type': 'application/json' });
      outgoing.end('{"error":{"message":"test-secret"}}');
    });
    const adapter = new DeepSeekModelAdapter(configuration(baseUrl, { maxRetries: 2 }));

    const error = await adapter.generate(request).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(DeepSeekAdapterError);
    expect(error).toMatchObject({ code: 'DEEPSEEK_AUTH_FAILED', retryable: false });
    expect(String(error)).not.toContain('test-secret');
    expect(attempts).toBe(1);
  });

  it('maps configured timeout and cancellation separately', async () => {
    const baseUrl = await serve(async (_incoming, outgoing) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      json(outgoing, completion({ content: 'late' }));
    });
    const adapter = new DeepSeekModelAdapter(
      configuration(baseUrl, { maxRetries: 0, timeoutMs: 100 }),
    );

    await expect(adapter.generate(request)).rejects.toMatchObject({ code: 'DEEPSEEK_TIMEOUT' });

    const controller = new AbortController();
    controller.abort('cancelled-by-caller');
    await expect(adapter.generate({ ...request, signal: controller.signal })).rejects.toMatchObject(
      { code: 'DEEPSEEK_CANCELLED' },
    );
  });

  it('keeps timeout classification after response headers arrive', async () => {
    const baseUrl = await serve(async (_incoming, outgoing) => {
      outgoing.writeHead(200, { 'Content-Type': 'application/json' });
      outgoing.flushHeaders();
      await new Promise((resolve) => setTimeout(resolve, 250));
      outgoing.end(JSON.stringify(completion({ content: 'late body' })));
    });
    const adapter = new DeepSeekModelAdapter(
      configuration(baseUrl, { maxRetries: 0, timeoutMs: 100 }),
    );

    await expect(adapter.generate(request)).rejects.toMatchObject({ code: 'DEEPSEEK_TIMEOUT' });
  });

  it('treats provider resource interruption as a retryable error', async () => {
    const baseUrl = await serve((_incoming, outgoing) => {
      const value = completion({ content: 'partial' });
      value.choices[0]!.finish_reason = 'insufficient_system_resource';
      json(outgoing, value);
    });
    const adapter = new DeepSeekModelAdapter(configuration(baseUrl));

    await expect(adapter.generate(request)).rejects.toMatchObject({
      code: 'DEEPSEEK_PROVIDER_FAILED',
      retryable: true,
    });
  });

  it('parses SSE text, tool calls, terminal usage, and DONE', async () => {
    const baseUrl = await serve((_incoming, outgoing) => {
      outgoing.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sse(outgoing, streamChunk({ content: 'verified ', id: 'stream-1' }));
      sse(
        outgoing,
        streamChunk({
          id: 'stream-1',
          toolCalls: [
            {
              function: { arguments: '{"query":', name: 'search_knowledge' },
              id: 'call-1',
              index: 0,
              type: 'function',
            },
          ],
        }),
      );
      sse(
        outgoing,
        streamChunk({
          finishReason: 'tool_calls',
          id: 'stream-1',
          toolCalls: [{ function: { arguments: '"GEO"}' }, index: 0, type: 'function' }],
        }),
      );
      sse(outgoing, {
        choices: [],
        id: 'stream-1',
        model: 'provider-model-response',
        usage: { completion_tokens: 5, prompt_tokens: 9, total_tokens: 14 },
      });
      outgoing.end('data: [DONE]\n\n');
    });
    const adapter = new DeepSeekModelAdapter(configuration(baseUrl));
    const events = [];

    for await (const event of adapter.stream({
      ...request,
      tools: [
        {
          description: 'Search scoped knowledge',
          inputSchema: { type: 'object' },
          name: 'search_knowledge',
        },
      ],
    })) {
      events.push(event);
    }

    expect(events.find((event) => event.type === 'text_delta')).toMatchObject({
      delta: 'verified ',
    });
    expect(events.find((event) => event.type === 'tool_call')).toMatchObject({
      toolCall: { arguments: { query: 'GEO' }, id: 'call-1', name: 'search_knowledge' },
    });
    expect(events.at(-1)).toMatchObject({
      result: { finishReason: 'tool_calls', usage: { totalTokens: 14 } },
      type: 'done',
    });
  });

  it('rejects unsupported JSON Schema response mode before network access', () => {
    const adapter = new DeepSeekModelAdapter(
      configuration('https://provider.invalid/v1', { maxRetries: 0 }),
    );

    expect(() =>
      adapter.estimate({
        ...request,
        responseFormat: {
          name: 'answer',
          schema: { type: 'object' },
          strict: true,
          type: 'json_schema',
        },
      }),
    ).toThrowError(DeepSeekAdapterError);
  });
});

function configuration(
  baseUrl: string,
  overrides: Partial<DeepSeekAdapterConfiguration> = {},
): DeepSeekAdapterConfiguration {
  return {
    apiKey: 'test-secret',
    baseUrl,
    maxOutputTokens: 4096,
    maxRetries: 0,
    modelKey: 'flash',
    providerModelId: 'provider-model-from-config',
    retryBaseDelayMs: 0,
    timeoutMs: 2_000,
    ...overrides,
  };
}

function completion(message: {
  readonly completionTokens?: number;
  readonly content: string;
  readonly finishReason?: string;
  readonly reasoningContent?: string;
}) {
  const completionTokens = message.completionTokens ?? 7;
  return {
    choices: [
      {
        finish_reason: message.finishReason ?? 'stop',
        index: 0,
        message: {
          content: message.content,
          ...(message.reasoningContent === undefined
            ? {}
            : { reasoning_content: message.reasoningContent }),
          role: 'assistant',
        },
      },
    ],
    id: 'provider-request-1',
    model: 'provider-model-response',
    usage: {
      completion_tokens: completionTokens,
      prompt_tokens: 11,
      total_tokens: completionTokens + 11,
    },
  };
}

function streamChunk(input: {
  readonly content?: string;
  readonly finishReason?: string;
  readonly id: string;
  readonly toolCalls?: readonly unknown[];
}) {
  return {
    choices: [
      {
        delta: { content: input.content ?? null, tool_calls: input.toolCalls ?? [] },
        finish_reason: input.finishReason ?? null,
        index: 0,
      },
    ],
    id: input.id,
    model: 'provider-model-response',
    usage: null,
  };
}

async function serve(
  handler: (incoming: IncomingMessage, outgoing: ServerResponse) => void | Promise<void>,
): Promise<string> {
  const server = createServer((incoming, outgoing) => {
    Promise.resolve(handler(incoming, outgoing)).catch((error: unknown) => {
      outgoing.destroy(error instanceof Error ? error : undefined);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  closers.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Test server address missing');
  return `http://127.0.0.1:${address.port}/v1`;
}

async function body(incoming: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function json(outgoing: ServerResponse, value: unknown): void {
  outgoing.writeHead(200, { 'Content-Type': 'application/json' });
  outgoing.end(JSON.stringify(value));
}

function sse(outgoing: ServerResponse, value: unknown): void {
  outgoing.write(`data: ${JSON.stringify(value)}\n\n`);
}
