import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

import { CloudflareWorkersAiImageAdapter } from './cloudflare.adapter.js';
import { readImageProviderConfiguration } from './config.js';
import { renderDouyinNoteCard, wrapDouyinNoteHeading, wrapDouyinNoteText } from './douyin-note.js';
import {
  applyAiDisclosure,
  imageHash,
  imageMetadata,
  inspectionPassed,
  normalizeGeneratedImage,
  normalizePublishedSourceImage,
  renderTemplateImage,
  sourceImageMetadata,
} from './image-processing.js';

describe('image adapter', () => {
  it('renders deterministic 3:4 Douyin image-note cards', async () => {
    const input = {
      body: '先列出物品、楼层和车辆条件，再按项目核对报价，避免只比较一个总价。',
      heading: '搬家报价怎么核对',
      index: 1,
      kind: 'body' as const,
      title: '广州搬家报价核对指南',
      total: 7,
    };
    const first = await renderDouyinNoteCard(input);
    const second = await renderDouyinNoteCard(input);
    expect(imageHash(first)).toBe(imageHash(second));
    expect(await imageMetadata(first)).toMatchObject({
      format: 'jpeg',
      height: 1_440,
      width: 1_080,
    });
    const headingClearance = await sharp(first)
      .extract({ height: 36, left: 80, top: 160, width: 700 })
      .removeAlpha()
      .raw()
      .toBuffer();
    const darkPixels = Array.from(
      { length: headingClearance.length / 3 },
      (_, index) => index * 3,
    ).filter(
      (offset) =>
        (headingClearance[offset] ?? 255) < 50 &&
        (headingClearance[offset + 1] ?? 255) < 70 &&
        (headingClearance[offset + 2] ?? 255) < 100,
    ).length;
    expect(darkPixels).toBe(0);
  });

  it('blocks text that cannot fit the deterministic Douyin card layout', async () => {
    await expect(
      renderDouyinNoteCard({
        body: '这是一段需要被拒绝的超长卡片正文。'.repeat(40),
        heading: '布局溢出验证',
        index: 1,
        kind: 'body',
        title: '测试标题',
        total: 5,
      }),
    ).rejects.toThrow('exceeds the deterministic layout');
  });

  it('avoids an orphaned final character in long Douyin cover headings', () => {
    expect(wrapDouyinNoteHeading('跨区搬家当天6个检查点', 'cover')).toEqual([
      '跨区搬家当天',
      '6个检查点',
    ]);
  });

  it('keeps decimal values intact when wrapping Douyin card text', () => {
    const source = '到场车型是否和报价一致？面包车、4.2米厢式货车、6.8米以上货车载量差很多。';
    const lines = wrapDouyinNoteText(source, 17);
    expect(lines.join('')).toBe(source);
    expect(lines.some((line) => line.includes('4.2'))).toBe(true);
    expect(lines.some((line) => line.includes('6.8'))).toBe(true);
    expect(lines.every((line) => !line.endsWith('4') && !line.startsWith('.2'))).toBe(true);
  });

  it('keeps Chinese words and closing punctuation on readable Douyin lines', () => {
    const cover = wrapDouyinNoteText('搬家当天盯住四件事：车辆、物品、打包、费用。', 17);
    const body = wrapDouyinNoteText(
      '家电家具是否做了防护包裹；易碎品单独装箱标注；拆装件记录顺序方便复位。',
      17,
    );

    expect(cover.join('')).toBe('搬家当天盯住四件事：车辆、物品、打包、费用。');
    expect(cover.some((line) => line.endsWith('打') || line.startsWith('包'))).toBe(false);
    expect(
      [...cover, ...body].every((line) => !/^[，。！？；：、）》】」』〕,.!?;:)]/u.test(line)),
    ).toBe(true);
    expect(
      [...cover, ...body].every((line) => !/^[，。！？；：、）》】」』〕,.!?;:)]+$/u.test(line)),
    ).toBe(true);
  });

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

  it('normalizes a publication source without applying an AI disclosure label', async () => {
    const source = await renderTemplateImage({
      accent: 'gold',
      label: '企业证照',
      title: '证照原图',
    });
    const sourceWithMetadata = await sharp(source).withMetadata({ orientation: 1 }).toBuffer();
    expect((await sharp(sourceWithMetadata).metadata()).exif).toBeDefined();
    const normalized = await normalizePublishedSourceImage(sourceWithMetadata);
    expect(await imageMetadata(normalized)).toMatchObject({
      format: 'jpeg',
      height: 800,
      width: 1_200,
    });
    expect((await sharp(normalized).metadata()).exif).toBeUndefined();
  });

  it('accepts a portrait certificate image and normalizes its publication copy', async () => {
    const portrait = await sharp({
      create: { background: '#ffffff', channels: 3, height: 1_200, width: 800 },
    })
      .jpeg()
      .toBuffer();
    expect(await sourceImageMetadata(portrait)).toMatchObject({ height: 1_200, width: 800 });
    expect(await imageMetadata(await normalizePublishedSourceImage(portrait))).toMatchObject({
      height: 800,
      width: 1_200,
    });
  });

  it('accepts a high-resolution certificate scan without relaxing the general media gate', async () => {
    const scan = await sharp({
      create: { background: '#ffffff', channels: 3, height: 4_493, width: 6_355 },
    })
      .jpeg({ quality: 85 })
      .toBuffer();
    await expect(imageMetadata(scan)).rejects.toThrow('media gate');
    expect(await sourceImageMetadata(scan)).toMatchObject({
      format: 'jpeg',
      height: 4_493,
      width: 6_355,
    });
    expect(await imageMetadata(await normalizePublishedSourceImage(scan))).toMatchObject({
      format: 'jpeg',
      height: 800,
      width: 1_200,
    });
  });

  it('rejects certificate scans beyond the high-resolution safety gate', async () => {
    const oversizedEdge = await sharp({
      create: { background: '#ffffff', channels: 3, height: 512, width: 8_193 },
    })
      .jpeg()
      .toBuffer();
    await expect(sourceImageMetadata(oversizedEdge)).rejects.toThrow('media gate');
  });

  it('calls the official Workers AI envelope without exposing provider errors', async () => {
    const generated = await renderTemplateImage({
      accent: 'gold',
      label: '场景',
      title: '测试标题',
    });
    const fetcher = async (_url: string | URL | Request, input?: RequestInit) => {
      const payload = JSON.parse(String(input?.body)) as {
        image?: string;
        messages?: { content?: string }[];
        prompt?: string;
        seed?: unknown;
        steps?: number;
      };
      if (payload.prompt) {
        expect(payload.seed).toBeUndefined();
        expect(payload.steps).toBe(4);
      } else {
        expect(payload.messages?.[1]?.content).toContain('article_relevance is at least 80');
      }
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

  it('accepts a complete JSON result after the vision model commentary', async () => {
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
              'The image does not clearly match the expected scene.\n\n{"decision":"block","article_relevance":0,"detected_text":[],"company_names":[],"logos_or_watermarks":[],"phone_numbers":[],"unsafe":false,"deceptive_realism":false,"issues":["scene mismatch"]}',
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
        requestId: 'inspection-commentary-json',
      }),
    ).resolves.toMatchObject({ articleRelevance: 0, decision: 'block' });
  });

  it('accepts explicit None lists and case variants in the labeled response', async () => {
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
              '* Decision: Pass\n* Article Relevance: 100%\n* Detected Text: None\n* Company Names: None\n* Logos or Watermarks: None\n* Phone Numbers: None\n* Unsafe: False\n* Deceptive Realism: False\n* Issues: None',
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
        requestId: 'inspection-none-labels',
      }),
    ).resolves.toMatchObject({
      articleRelevance: 100,
      decision: 'pass',
      detectedText: [],
      unsafe: false,
    });
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
