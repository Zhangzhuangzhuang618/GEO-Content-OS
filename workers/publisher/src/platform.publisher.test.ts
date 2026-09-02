import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { InMemoryStorageAdapter } from '@geo-content-os/adapter-storage';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertEnterpriseEvidencePublishGate, PlatformPublisher } from './platform.publisher.js';
import type { PublishClaim } from './publisher.types.js';

const fixtureUrl = new URL(
  '../../../packages/adapters/platforms/official_site/render/fixtures/official-site.valid.input.json',
  import.meta.url,
);
const liejuFixtureUrl = new URL(
  '../../../packages/adapters/platforms/lieju/render/fixtures/lieju.valid.input.json',
  import.meta.url,
);
const douyinFixtureUrl = new URL(
  '../../../packages/adapters/platforms/douyin/render/fixtures/douyin.valid.input.json',
  import.meta.url,
);

describe('PlatformPublisher', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('blocks official and Lieju delivery when baseline evidence mapping or customer copy is invalid', () => {
    const companyName = '广州甲方搬家有限公司';
    const sourceIds = [randomUUID(), randomUUID()];
    const valid = createClaim(
      {
        blocks: [
          {
            block_key: 'enterprise-credentials',
            block_type: 'paragraph',
            text: `依法登记的企业可查询工商信息。${companyName}已提供营业执照和道路运输证，可供客户核验。`,
          },
        ],
        schema_version: 'content-writer-data@1',
      },
      [],
      [],
      {
        enterpriseEvidenceGate: {
          companyName,
          evidenceNames: ['营业执照', '道路运输证'],
          mappedSourceIds: sourceIds,
          missingRequiredKinds: [],
          requiredSourceIds: sourceIds,
        },
        ownerCompanyNames: [companyName],
      },
    );
    expect(() => assertEnterpriseEvidencePublishGate(valid)).not.toThrow();
    expect(() =>
      assertEnterpriseEvidencePublishGate({ ...valid, platformCode: 'lieju' }),
    ).not.toThrow();
    expect(() =>
      assertEnterpriseEvidencePublishGate({
        ...valid,
        enterpriseEvidenceGate: {
          ...valid.enterpriseEvidenceGate!,
          mappedSourceIds: [sourceIds[0]!],
        },
      }),
    ).toThrow(/ENTERPRISE_EVIDENCE_MAPPING_INCOMPLETE/u);
    expect(() =>
      assertEnterpriseEvidencePublishGate({
        ...valid,
        enterpriseEvidenceGate: {
          ...valid.enterpriseEvidenceGate!,
          missingRequiredKinds: ['insurance_or_damage_protection'],
        },
      }),
    ).toThrow(/ENTERPRISE_EVIDENCE_INCOMPLETE/u);
    expect(() =>
      assertEnterpriseEvidencePublishGate({
        ...valid,
        enterpriseEvidenceGate: {
          ...valid.enterpriseEvidenceGate!,
          mappedSourceIds: [...sourceIds, randomUUID()],
        },
      }),
    ).toThrow(/ENTERPRISE_EVIDENCE_MAPPING_INCOMPLETE/u);
    expect(() =>
      assertEnterpriseEvidencePublishGate({
        ...valid,
        content: {
          ...valid.content,
          blocks: [
            {
              block_key: 'enterprise-credentials',
              block_type: 'paragraph',
              text: `${companyName}已提供营业执照和道路运输证，但仅反映企业基本状况，不代表服务质量。`,
            },
          ],
        },
      }),
    ).toThrow(/INTERNAL_CUSTOMER_COPY_BLOCKED/u);
  });

  it('allows official and Lieju delivery without evidence when the workspace requires none', () => {
    const companyName = '广州甲方服务有限公司';
    const claim = createClaim(
      {
        blocks: [
          {
            block_key: 'body',
            block_type: 'paragraph',
            text: '根据实际需求说明服务流程和注意事项。',
          },
        ],
        schema_version: 'content-writer-data@1',
      },
      [],
      [],
      {
        enterpriseEvidenceGate: {
          companyName,
          evidenceNames: [],
          mappedSourceIds: [],
          missingRequiredKinds: [],
          requiredSourceIds: [],
        },
        ownerCompanyNames: [companyName],
      },
    );

    expect(() => assertEnterpriseEvidencePublishGate(claim)).not.toThrow();
    expect(() =>
      assertEnterpriseEvidencePublishGate({ ...claim, platformCode: 'lieju' }),
    ).not.toThrow();
    expect(() =>
      assertEnterpriseEvidencePublishGate({
        ...claim,
        enterpriseEvidenceGate: {
          ...claim.enterpriseEvidenceGate!,
          missingRequiredKinds: ['business_license'],
        },
      }),
    ).toThrow(/ENTERPRISE_EVIDENCE_INCOMPLETE/u);
  });

  it('blocks internal risk-control language on every publishing platform', () => {
    const claim = createClaim(
      {
        blocks: [
          {
            block_key: 'body',
            block_type: 'paragraph',
            text: '资料属于企业第一方口径，需自行核实。',
          },
        ],
        schema_version: 'content-writer-data@1',
      },
      [],
      [],
      { platformCode: 'sohu' },
    );

    expect(() => assertEnterpriseEvidencePublishGate(claim)).toThrow(
      /INTERNAL_CUSTOMER_COPY_BLOCKED/u,
    );
  });

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

  it('injects the complete ordered Douyin card assets into the frozen browser payload', async () => {
    const fixture = (await readJson(douyinFixtureUrl)) as {
      readonly citations: PublishClaim['citations'];
      readonly content: Readonly<Record<string, unknown>>;
    };
    const cards = [
      { body: '报价不能只看总价。', card_key: 'cover', heading: '搬家报价怎么核对', kind: 'cover' },
      {
        body: '确认物品、楼层和停车距离。',
        card_key: 'scope',
        heading: '先确认范围',
        kind: 'body',
      },
      {
        body: '逐项查看车辆、人工和材料。',
        card_key: 'items',
        heading: '再核对项目',
        kind: 'body',
      },
      { body: '把可能加价的条件写清楚。', card_key: 'risk', heading: '明确费用边界', kind: 'body' },
      {
        body: '保留书面项目和验收约定。',
        card_key: 'summary',
        heading: '最后检查',
        kind: 'summary',
      },
    ] as const;
    const assetIds = Array.from({ length: cards.length }, () => randomUUID());
    const positions = [4, 0, 2, 1, 3] as const;
    const mediaAssets = positions.map((position) => ({
      altText: `抖音图文第${position + 1}页`,
      contentHash: String(position).repeat(64),
      id: assetIds[position]!,
      mimeType: 'image/jpeg' as const,
      objectUri: `memory://publisher/douyin-${position}.jpg`,
      position,
      publicUrl: null,
      role: position === 0 ? ('cover' as const) : ('body' as const),
      sizeBytes: 100,
      source: 'template' as const,
    }));
    const claim = createClaim(
      {
        ...fixture.content,
        platform_meta: {
          cards,
          content_kind: 'image_note',
          description: '搬家报价逐项核对指南。',
          topics: ['搬家指南'],
        },
        schema_version: 'content-writer-data@1',
      },
      fixture.citations,
      mediaAssets,
      {
        idempotencyKey: `douyin:${randomUUID()}`,
        platformCode: 'douyin',
        publishMode: 'api',
      },
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, { get_status: true, metrics: false, publish: true }))
      .mockResolvedValueOnce(
        jsonResponse(201, {
          external_id: 'douyin-publication-fingerprint',
          status: 'processing',
          url: null,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new PlatformPublisher().deliver(claim, {
      base_url: 'https://douyin-gateway.example/',
      bearer_token: 'test-secret',
    });

    expect(result).toMatchObject({ mode: 'api', response: { status: 'processing' } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const request = fetchMock.mock.calls[1]?.[1];
    const body = JSON.parse(String(request?.body)) as {
      payload: { image_asset_ids: readonly string[] };
    };
    expect(body.payload.image_asset_ids).toEqual(assetIds);
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
