import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { InMemoryStorageAdapter } from '@geo-content-os/adapter-storage';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlatformPublisher } from './platform.publisher.js';
import type { PublishClaim } from './publisher.types.js';

const fixtureUrl = new URL(
  '../../../packages/adapters/platforms/official_site/render/fixtures/official-site.valid.input.json',
  import.meta.url,
);
const liejuFixtureUrl = new URL(
  '../../../packages/adapters/platforms/lieju/render/fixtures/lieju.valid.input.json',
  import.meta.url,
);

describe('PlatformPublisher', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('removes content storage metadata before rendering an official-site export', async () => {
    const fixture = (await readJson(fixtureUrl)) as {
      readonly citations: PublishClaim['citations'];
      readonly content: Readonly<Record<string, unknown>>;
    };
    const claim = createClaim(
      {
        ...fixture.content,
        schema_version: 'content-writer-data@1',
      },
      fixture.citations,
      [
        {
          altText: '搬家验收封面示意图',
          contentHash: 'b'.repeat(64),
          id: randomUUID(),
          mimeType: 'image/jpeg',
          objectUri: 'memory://publisher/cover.jpg',
          position: 0,
          publicUrl: 'https://cdn.example.com/generated-media/cover.jpg',
          role: 'cover',
          sizeBytes: 100,
          source: 'template',
        },
      ],
    );

    const result = await new PlatformPublisher().deliver(claim, null);

    expect(result.mode).toBe('export');
    if (result.mode !== 'export') return;
    expect(result.bundle).toMatchObject({
      platform_code: 'official_site',
      schema_version: 'official-site-export@1',
    });
    expect(JSON.stringify(result.bundle)).toContain(
      'https://cdn.example.com/generated-media/cover.jpg',
    );
  });

  it('rejects unsupported content storage schemas', async () => {
    const fixture = (await readJson(fixtureUrl)) as {
      readonly content: Readonly<Record<string, unknown>>;
    };
    const claim = createClaim({
      ...fixture.content,
      schema_version: 'content-writer-data@2',
    });

    await expect(new PlatformPublisher().deliver(claim, null)).rejects.toThrow(
      'CONTENT_SCHEMA_UNSUPPORTED',
    );
  });

  it('uses the current tenant owner name for official-site render validation', async () => {
    const fixture = (await readJson(fixtureUrl)) as {
      readonly citations: PublishClaim['citations'];
      readonly content: Readonly<Record<string, unknown>> & {
        readonly blocks: readonly Readonly<Record<string, unknown>>[];
      };
    };
    const owner = '广东众人搬家起重吊装有限公司';
    const otherTenant = '广州志远搬家服务有限公司';
    const withCompany = (company: string) => ({
      ...fixture.content,
      blocks: fixture.content.blocks.map((block, index) =>
        index === 0
          ? { ...block, text: `${String(block['text'])}${company}会核对服务记录。` }
          : block,
      ),
      schema_version: 'content-writer-data@1',
    });

    await expect(
      new PlatformPublisher().deliver(
        createClaim(withCompany(owner), fixture.citations, [], { ownerCompanyNames: [owner] }),
        null,
      ),
    ).resolves.toMatchObject({ mode: 'export' });
    await expect(
      new PlatformPublisher().deliver(
        createClaim(withCompany(otherTenant), fixture.citations, [], {
          ownerCompanyNames: [owner],
        }),
        null,
      ),
    ).rejects.toThrow('OTHER_COMPANY_NAME_FORBIDDEN');
  });

  it('uploads local immutable media before publishing official-site HTML', async () => {
    const fixture = (await readJson(fixtureUrl)) as {
      readonly citations: PublishClaim['citations'];
      readonly content: Readonly<Record<string, unknown>>;
    };
    const storage = new InMemoryStorageAdapter('publisher-media');
    const body = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const contentHash = createHash('sha256').update(body).digest('hex');
    const assetId = randomUUID();
    await storage.putObject({
      body,
      contentHash,
      contentType: 'image/jpeg',
      key: 'generated-media/cover.jpg',
    });
    const claim = {
      ...createClaim(
        { ...fixture.content, schema_version: 'content-writer-data@1' },
        fixture.citations,
        [
          {
            altText: '搬家验收封面示意图',
            contentHash,
            id: assetId,
            mimeType: 'image/jpeg',
            objectUri: storage.objectUri('generated-media/cover.jpg'),
            position: 0,
            publicUrl: null,
            role: 'cover',
            sizeBytes: body.byteLength,
            source: 'template',
          },
        ],
      ),
      publishMode: 'api' as const,
    };
    const mediaUrl = `https://cms.example.com/upload/geo/${contentHash.slice(0, 2)}/${contentHash}.jpg`;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          get_status: true,
          media_upload: true,
          metrics: false,
          publish: true,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(201, {
          asset_id: assetId,
          content_hash: contentHash,
          content_type: 'image/jpeg',
          size_bytes: body.byteLength,
          url: mediaUrl,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(201, {
          external_id: 'article-1',
          published_at: '2026-08-04T08:00:00+08:00',
          status: 'published',
          url: 'https://cms.example.com/detail/news1.html',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new PlatformPublisher(storage).deliver(claim, {
      base_url: 'https://cms.example.com/api/geo/v1/',
      bearer_token: 'test-secret',
    });

    expect(result).toMatchObject({
      mode: 'api',
      response: {
        media_upload: {
          available: true,
          skipped: 0,
          uploaded: [{ asset_id: assetId, url: mediaUrl }],
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const publishRequest = fetchMock.mock.calls[2]?.[1];
    const publishedBody = JSON.parse(String(publishRequest?.body)) as {
      payload: { body_html: string };
    };
    expect(publishedBody.payload.body_html).toContain(mediaUrl);
  });

  it('publishes Lieju content with private media without browser-only body asset metadata', async () => {
    const fixture = (await readJson(liejuFixtureUrl)) as {
      readonly citations: PublishClaim['citations'];
      readonly content: Readonly<Record<string, unknown>>;
    };
    const privateAsset = (role: 'body' | 'cover', position: number) => ({
      altText: `列举网${role}图`,
      contentHash: (role === 'cover' ? 'c' : 'd').repeat(64),
      id: randomUUID(),
      mimeType: 'image/jpeg',
      objectUri: `memory://publisher/${role}-${position}.jpg`,
      position,
      publicUrl: null,
      role,
      sizeBytes: 100,
      source: 'template' as const,
    });
    const claim = createClaim(
      { ...fixture.content, schema_version: 'content-writer-data@1' },
      fixture.citations,
      [privateAsset('cover', 0), privateAsset('body', 1)],
      {
        idempotencyKey: `lieju:${randomUUID()}`,
        liejuDeliveryMethod: 'official_api',
        platformCode: 'lieju',
        publishMode: 'api',
      },
    );
    let requestBody: Uint8Array | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      requestBody = init?.body as Uint8Array;
      return jsonResponse(200, { info_id: 104_561_173, success: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new PlatformPublisher().deliver(claim, {
      api_key: 'official-api-key-123456',
      city_id: '5',
      delivery_method: 'official_api',
      fid: '73',
      posting_profile: {
        address: '广州市天河区示例路',
        contact_name: '广州志远搬家服务有限公司',
        mobile_phone: '02085627757',
        qq: '',
        wechat: '',
        zone_id: '73',
      },
      timeout_ms: 20_000,
    });

    expect(result).toMatchObject({ externalId: '104561173', mode: 'api' });
    expect(fetchMock).toHaveBeenCalledOnce();
    const multipart = Buffer.from(requestBody ?? []).toString('latin1');
    expect(multipart).not.toContain('body_asset_ids');
    expect(multipart).not.toContain('[img]');
  });
});

function createClaim(
  content: Readonly<Record<string, unknown>>,
  citations: PublishClaim['citations'] = [],
  mediaAssets: NonNullable<PublishClaim['mediaAssets']> = [],
  overrides: Partial<PublishClaim> = {},
): PublishClaim {
  return {
    accountId: randomUUID(),
    accountStatus: 'active',
    accountTokenExpiresAt: null,
    attempt: 1,
    citations,
    content,
    contentVersionId: randomUUID(),
    credentialCiphertext: null,
    credentialKeyVersion: null,
    idempotencyKey: `official-site:${randomUUID()}`,
    jobId: randomUUID(),
    mediaAssets,
    officialSiteServicePhone: '02085627757',
    ownerCompanyNames: [],
    payloadHash: 'a'.repeat(64),
    platformCode: 'official_site',
    publishMode: 'export',
    tenantId: randomUUID(),
    ...overrides,
  };
}

async function readJson(url: URL): Promise<unknown> {
  return JSON.parse(await readFile(url, 'utf8')) as unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}
