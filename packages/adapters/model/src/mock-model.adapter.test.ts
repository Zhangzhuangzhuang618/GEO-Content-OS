import { describe, expect, it } from 'vitest';

import { MockModelAdapter, ModelAdapterError } from './index.js';

const request = {
  maxOutputTokens: 256,
  messages: [{ content: 'Summarize the verified source.', role: 'user' as const }],
  requestId: 'request-00000001',
};

describe('MockModelAdapter', () => {
  it('exposes capabilities and a provider-neutral token estimate', () => {
    const adapter = new MockModelAdapter({ modelKey: 'flash' });

    expect(adapter.capabilities()).toEqual({
      jsonMode: true,
      jsonSchema: true,
      maxOutputTokens: 8192,
      streaming: true,
      toolCalling: true,
    });
    expect(adapter.estimate(request)).toMatchObject({
      maximumOutputTokens: 256,
      modelKey: 'flash',
    });
    expect(adapter.estimate(request).estimatedInputTokens).toBeGreaterThan(0);
  });

  it('generates a JSON object and records model usage', async () => {
    const adapter = new MockModelAdapter({
      modelKey: 'flash',
      responses: [{ text: '{"answer":"verified"}' }],
    });

    const result = await adapter.generate({
      ...request,
      responseFormat: { type: 'json_object' },
    });

    expect(JSON.parse(result.message.content!)).toEqual({ answer: 'verified' });
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toMatchObject({
      modelKey: 'flash',
      providerCode: 'mock',
      providerModelId: 'mock-model-v1',
    });
    expect(result.usage.totalTokens).toBe(result.usage.inputTokens + result.usage.outputTokens);
  });

  it('returns only registered tool calls', async () => {
    const adapter = new MockModelAdapter({
      responses: [
        {
          toolCalls: [{ arguments: { query: 'GEO' }, id: 'call-1', name: 'search_knowledge' }],
        },
      ],
    });
    const result = await adapter.generate({
      ...request,
      toolChoice: 'required',
      tools: [
        {
          description: 'Search scoped knowledge',
          inputSchema: {
            additionalProperties: false,
            properties: { query: { type: 'string' } },
            required: ['query'],
            type: 'object',
          },
          name: 'search_knowledge',
        },
      ],
    });

    expect(result.finishReason).toBe('tool_calls');
    expect(result.message.toolCalls?.[0]?.name).toBe('search_knowledge');
  });

  it('enforces required tool selection against mock responses', async () => {
    const adapter = new MockModelAdapter({ responses: [{ text: 'plain response' }] });

    await expect(
      adapter.generate({
        ...request,
        toolChoice: { name: 'search_knowledge' },
        tools: [
          {
            description: 'Search scoped knowledge',
            inputSchema: { type: 'object' },
            name: 'search_knowledge',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'MODEL_RESPONSE_INVALID' });
  });

  it('streams text and emits one terminal result', async () => {
    const adapter = new MockModelAdapter({
      responses: [{ text: 'deterministic stream' }],
      streamChunkSize: 5,
    });
    let text = '';
    let terminal = 0;

    for await (const event of adapter.stream(request)) {
      if (event.type === 'text_delta') text += event.delta;
      if (event.type === 'done') terminal += 1;
    }

    expect(text).toBe('deterministic stream');
    expect(terminal).toBe(1);
  });

  it('rejects unsupported capabilities, invalid JSON, and cancellation', async () => {
    const unsupported = new MockModelAdapter({ capabilities: { jsonMode: false } });
    await expect(
      unsupported.generate({ ...request, responseFormat: { type: 'json_object' } }),
    ).rejects.toMatchObject({ code: 'MODEL_CAPABILITY_UNAVAILABLE' });

    const invalid = new MockModelAdapter({ responses: [{ text: 'not-json' }] });
    await expect(
      invalid.generate({ ...request, responseFormat: { type: 'json_object' } }),
    ).rejects.toMatchObject({ code: 'MODEL_RESPONSE_INVALID' });

    const controller = new AbortController();
    controller.abort('cancelled');
    await expect(
      new MockModelAdapter().generate({ ...request, signal: controller.signal }),
    ).rejects.toBeInstanceOf(ModelAdapterError);
  });

  it('rejects non-JSON runtime schemas at the adapter boundary', () => {
    const adapter = new MockModelAdapter();

    expect(() =>
      adapter.estimate({
        ...request,
        responseFormat: {
          name: 'answer',
          schema: { invalid: undefined } as never,
          strict: true,
          type: 'json_schema',
        },
      }),
    ).toThrowError(ModelAdapterError);
  });
});
