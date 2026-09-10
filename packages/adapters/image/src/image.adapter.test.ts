import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

import { CloudflareWorkersAiImageAdapter } from './cloudflare.adapter.js';
import { readImageProviderConfiguration } from './config.js';
import {
  normalizeDouyinNoteBackground,
  renderDouyinNoteCard,
  splitChecklistItems,
  wrapDouyinNoteHeading,
  wrapDouyinNoteText,
} from './douyin-note.js';
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
  it.each(['focus', 'checklist'] as const)(
    'keeps long %s titles inside the content margin',
    async (layout) => {
      const rendered = await renderDouyinNoteCard({
        heading: '广州日式搬迁半日式与全日式',
        body: '半日式包含整理收纳和搬迁，全日式额外包含衣物入柜和厨房物品拆包摆放。',
        title: '广州日式搬家怎么选',
        kind: 'body',
        layout,
        index: 2,
        total: 7,
      });
      const pixels = await sharp(rendered)
        .extract({ left: 988, top: 240, width: 40, height: 220 })
        .removeAlpha()
        .raw()
        .toBuffer();
      let dark = 0;
      for (let i = 0; i < pixels.length; i += 3)
        if (pixels[i]! < 100 && pixels[i + 1]! < 120 && pixels[i + 2]! < 140) dark++;
      expect(dark).toBe(0);
      expect(await imageMetadata(rendered)).toMatchObject({ width: 1080, height: 1440 });
    },
  );
  it('keeps a full company excerpt inside the focus quote box', async () => {
    const rendered = await renderDouyinNoteCard({
      heading: '日式家庭搬迁整理归位',
      body: '广东众人搬家起重吊装有限公司：该公司承接日式家庭搬迁，打包、搬运和还原整理都包含在服务里。\n全日式在半日式基础上，多了衣物入柜和厨房物品拆包摆放。',
      title: '广州日式搬家怎么选',
      kind: 'body',
      layout: 'focus',
      index: 2,
      total: 7,
    });
    for (const region of [
      { left: 980, top: 740, width: 40, height: 430 },
      { left: 120, top: 1165, width: 850, height: 50 },
    ]) {
      const pixels = await sharp(rendered).extract(region).removeAlpha().raw().toBuffer();
      let darkPixels = 0;
      for (let offset = 0; offset < pixels.length; offset += 3)
        if (pixels[offset]! < 100 && pixels[offset + 1]! < 120 && pixels[offset + 2]! < 140)
          darkPixels++;
      expect(darkPixels).toBe(0);
    }
  });
  it('keeps a valid 13-character summary heading inside the right margin', async () => {
    const rendered = await renderDouyinNoteCard({
      heading: '按整理需求选套餐并确认收费',
      body: '按搬后整理需求选半日式或全日式，提前确认拆装额外收费，再带物品清单沟通进场安排。',
      title: '广州日式搬家怎么选',
      kind: 'summary',
      layout: 'summary',
      index: 6,
      total: 7,
    });
    const edge = await sharp(rendered)
      .extract({ left: 1020, top: 230, width: 60, height: 240 })
      .removeAlpha()
      .raw()
      .toBuffer();
    let whitePixels = 0;
    for (let offset = 0; offset < edge.length; offset += 3)
      if (edge[offset]! > 235 && edge[offset + 1]! > 235 && edge[offset + 2]! > 235) whitePixels++;
    expect(whitePixels).toBe(0);
    expect(await imageMetadata(rendered)).toMatchObject({ width: 1080, height: 1440 });
  });
  it('preserves a complete long sentence instead of inventing numbered items from wrapped lines', async () => {
    const body =
      '重点看能否承接从拆卸到新家组装的全流程，是否对零件单独收纳标记，以及费用是否按家具类型和拆装难度确认。';
    expect(splitChecklistItems(body)).toEqual([body]);
    const image = await renderDouyinNoteCard({
      body,
      heading: '怎么选拆装公司',
      index: 5,
      kind: 'summary',
      layout: 'summary',
      title: '家具拆装怎么选',
      total: 6,
    });
    expect(await imageMetadata(image)).toMatchObject({ width: 1080, height: 1440 });
    await expect(
      renderDouyinNoteCard({
        body: '完整长句'.repeat(100),
        heading: '不能默默截断',
        index: 5,
        kind: 'summary',
        layout: 'summary',
        title: '家具拆装怎么选',
        total: 6,
      }),
    ).rejects.toThrow('exceeds');
  });
  it('removes only leading list markers to prevent double numbering', () => {
    expect(splitChecklistItems('1.5米宽度需要测量。')).toEqual(['1.5米宽度需要测量。']);
    expect(splitChecklistItems('①核对家具清单。②确认拆装安排。③检查组装效果。')).toEqual([
      '核对家具清单。',
      '确认拆装安排。',
      '检查组装效果。',
    ]);
    expect(splitChecklistItems('1.核对家具清单\n2、确认拆装安排')).toEqual([
      '核对家具清单',
      '确认拆装安排',
    ]);
    expect(splitChecklistItems('费用为1.5元，文字中的数字不能删除。')).toEqual([
      '费用为1.5元，文字中的数字不能删除。',
    ]);
  });
  it('renders deterministic 3:4 Douyin image-note cards', async () => {
    const input = {
      body: '先列出物品、楼层和车辆条件，再按项目核对报价，避免只比较一个总价。',
      heading: '搬家报价怎么核对',
      index: 1,
      kind: 'body' as const,
      layout: 'checklist' as const,
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
        layout: 'focus',
        title: '测试标题',
        total: 5,
      }),
    ).rejects.toThrow('exceeds the deterministic layout');
  });

  it('keeps the T158 long-card renderer available for immutable legacy content', async () => {
    const card = await renderDouyinNoteCard({
      body: '先核对旧址与新址的楼层、电梯、停车和搬运距离，再按物品体积选择车型。大件家具需要单独确认拆装方式，易碎品应记录打包和搬运要求；报价还要写清等待、加项及异常处理边界。'.repeat(
        2,
      ),
      heading: '旧图文内容继续按原版式完整渲染',
      index: 1,
      kind: 'body',
      layout: 'legacy',
      title: '旧抖音图文内容兼容验证',
      total: 5,
    });

    expect(await imageMetadata(card)).toMatchObject({ height: 1_440, width: 1_080 });
  });

  it('composes a generated portrait background with server-owned readable text', async () => {
    const source = await renderTemplateImage({
      accent: 'teal',
      label: '场景背景',
      title: '该文字只用于构造测试图片',
    });
    const background = await normalizeDouyinNoteBackground(source);
    const card = await renderDouyinNoteCard({
      background,
      body: '先确认装卸条件，再核对车辆与电梯时段，避免临时等待。',
      heading: '先把时间条件排清楚',
      index: 2,
      kind: 'body',
      layout: 'photo',
      title: '跨区搬家怎么安排',
      total: 7,
    });

    expect(await imageMetadata(background)).toMatchObject({ height: 1_440, width: 1_080 });
    expect(await imageMetadata(card)).toMatchObject({ height: 1_440, width: 1_080 });
    expect(imageHash(card)).not.toBe(imageHash(background));
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

  it.each(['jpeg', 'png', 'webp'] as const)(
    'fully decodes valid %s source images',
    async (format) => {
      const body = await sharp({
        create: { background: '#ffffff', channels: 3, height: 512, width: 768 },
      })
        .toFormat(format)
        .toBuffer();
      expect(await sourceImageMetadata(body)).toMatchObject({ format, height: 512, width: 768 });
    },
  );

  it('accepts JPEG trailers but rejects truncated pixel data with an appended end marker', async () => {
    const jpeg = Buffer.from(
      await renderTemplateImage({
        accent: 'blue',
        label: '测试图片',
        title: '图片完整解码测试',
      }),
    );
    const withTrailer = Buffer.concat([jpeg, Buffer.alloc(24, 0x7a)]);
    expect(await sourceImageMetadata(withTrailer)).toMatchObject({
      format: 'jpeg',
      sizeBytes: withTrailer.length,
    });
    const truncated = Buffer.concat([
      jpeg.subarray(0, Math.floor(jpeg.length / 2)),
      Buffer.from([0xff, 0xd9]),
    ]);
    expect((await sharp(truncated).metadata()).width).toBe(1_200);
    await expect(sourceImageMetadata(truncated)).rejects.toThrow('media gate');
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
