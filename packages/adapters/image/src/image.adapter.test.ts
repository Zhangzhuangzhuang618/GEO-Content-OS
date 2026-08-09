import { describe, expect, it } from 'vitest';

import { CloudflareWorkersAiImageAdapter } from './cloudflare.adapter.js';
import { readImageProviderConfiguration } from './config.js';
import {
  applyAiDisclosure,
  imageHash,
  imageMetadata,
  inspectionPassed,
  normalizeGeneratedImage,
  renderTemplateImage,
} from './image-processing.js';

describe('image adapter', () => {
  it('renders deterministic publishable templates and disclosure labels', async () => {
    const first = await renderTemplateImage({
      accent: 'blue',
      label: '搬家验收指南',
      title: '广州搬家完成后如何检查和验收更稳妥',
    });
    const second = await renderTemplateImage({
      accent: 'blue',
      label: '搬家验收指南',
      title: '广州搬家完成后如何检查和验收更稳妥',
    });
    expect(imageHash(first)).toBe(imageHash(second));
    expect(await imageMetadata(first)).toMatchObject({ height: 800, width: 1_200 });
    expect(await imageMetadata(await applyAiDisclosure(first))).toMatchObject({
      height: 800,
      width: 1_200,
    });
  });

  it('normalizes Cloudflare output and requires a strict inspection pass', async () => {
    const source = await renderTemplateImage({
      accent: 'teal',
      label: '核对清单',
      title: '测试标题',
    });
    expect(await imageMetadata(await normalizeGeneratedImage(source))).toMatchObject({
      format: 'jpeg',
      height: 800,
      width: 1_200,
    });
    expect(
      inspectionPassed({
        articleRelevance: 90,
        companyNames: [],
        decision: 'pass',
        deceptiveRealism: false,
        detectedText: [],
        issues: [],
        logosOrWatermarks: [],
        modelId: '@cf/meta/llama-3.2-11b-vision-instruct',
        phoneNumbers: [],
        providerCode: 'cloudflare',
        providerRequestId: 'qa-1',
        unsafe: false,
      }),
    ).toBe(true);
    expect(
      inspectionPassed({
        articleRelevance: 95,
        companyNames: ['某真实公司'],
        decision: 'pass',
        deceptiveRealism: false,
        detectedText: [],
        issues: [],
        logosOrWatermarks: [],
        modelId: '@cf/meta/llama-3.2-11b-vision-instruct',
        phoneNumbers: [],
        providerCode: 'cloudflare',
        providerRequestId: 'qa-2',
        unsafe: false,
      }),
    ).toBe(false);
  });

  it('calls the official Workers AI envelope without exposing provider errors', async () => {
    const generated = await renderTemplateImage({
      accent: 'gold',
      label: '场景',
      title: '测试标题',
    });
    const fetcher = async (_url: string | URL | Request, input?: RequestInit) => {
      const payload = JSON.parse(String(input?.body)) as { image?: string; prompt?: string };
      const result = payload.prompt
        ? { image: Buffer.from(generated).toString('base64'), request_id: 'cf-generation' }
        : {
            request_id: 'cf-inspection',
            response: JSON.stringify({
              article_relevance: 95,
              company_names: [],
              decision: 'pass',
              deceptive_realism: false,
              detected_text: [],
              issues: [],
              logos_or_watermarks: [],
              phone_numbers: [],
              unsafe: false,
            }),
          };
      return new Response(JSON.stringify({ errors: [], messages: [], result, success: true }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      });
    };
    const adapter = new CloudflareWorkersAiImageAdapter(
      {
        accountId: 'account-id',
        apiToken: 'secret-token',
        generationModel: '@cf/black-forest-labs/flux-1-schnell',
        inspectionModel: '@cf/meta/llama-3.2-11b-vision-instruct',
        timeoutMs: 5_000,
      },
      fetcher as typeof fetch,
    );
    const image = await adapter.generate({
      prompt: 'Editorial illustration without text.',
      requestId: 'generation-1',
      seed: 7,
      steps: 4,
    });
    expect(image.providerRequestId).toBe('cf-generation');
    expect(
      await adapter.inspect({
        body: image.body,
        expectedScene: 'A moving checklist illustration.',
        mimeType: image.mimeType,
        requestId: 'inspection-1',
      }),
    ).toMatchObject({ articleRelevance: 95, decision: 'pass' });
  });

  it('accepts the vision model complete labeled response when JSON mode returns Markdown', async () => {
    const generated = await renderTemplateImage({
      accent: 'teal',
      label: '场景',
      title: '测试标题',
    });
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          errors: [],
          messages: [],
          result: {
            response:
              'The image matches the expected editorial scene.\n\n**Decision:** pass\n\n**Article Relevance:** 100\n\n**Detected Text:** []\n\n**Company Names:** []\n\n**Logos or Watermarks:** []\n\n**Phone Numbers:** []\n\n**Unsafe:** false\n\n**Deceptive Realism:** false\n\n**Issues:** []',
          },
          success: true,
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      );
    const adapter = new CloudflareWorkersAiImageAdapter(
      {
        accountId: 'account-id',
        apiToken: 'secret-token',
        generationModel: '@cf/black-forest-labs/flux-1-schnell',
        inspectionModel: '@cf/meta/llama-3.2-11b-vision-instruct',
        timeoutMs: 5_000,
      },
      fetcher as typeof fetch,
    );

    await expect(
      adapter.inspect({
        body: generated,
        expectedScene: 'A moving checklist illustration.',
        mimeType: 'image/png',
        requestId: 'inspection-markdown',
      }),
    ).resolves.toMatchObject({ articleRelevance: 100, decision: 'pass' });
  });

  it('rejects labeled responses with a missing quality field', async () => {
    const generated = await renderTemplateImage({
      accent: 'teal',
      label: '场景',
      title: '测试标题',
    });
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          errors: [],
          messages: [],
          result: {
            response:
              '**Decision:** pass\n**Article Relevance:** 100\n**Detected Text:** []\n**Company Names:** []\n**Logos or Watermarks:** []\n**Phone Numbers:** []\n**Deceptive Realism:** false\n**Issues:** []',
          },
          success: true,
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      );
    const adapter = new CloudflareWorkersAiImageAdapter(
      {
        accountId: 'account-id',
        apiToken: 'secret-token',
        generationModel: '@cf/black-forest-labs/flux-1-schnell',
        inspectionModel: '@cf/meta/llama-3.2-11b-vision-instruct',
        timeoutMs: 5_000,
      },
      fetcher as typeof fetch,
    );

    await expect(
      adapter.inspect({
        body: generated,
        expectedScene: 'A moving checklist illustration.',
        mimeType: 'image/png',
        requestId: 'inspection-incomplete-markdown',
      }),
    ).rejects.toThrow(/inspection JSON is invalid/u);
  });

  it('requires credentials only when Cloudflare is enabled', () => {
    expect(readImageProviderConfiguration({ IMAGE_GENERATION_DRIVER: 'disabled' })).toEqual({
      driver: 'disabled',
      provider: null,
    });
    expect(() => readImageProviderConfiguration({ IMAGE_GENERATION_DRIVER: 'cloudflare' })).toThrow(
      /CLOUDFLARE_ACCOUNT_ID/u,
    );
  });
});
