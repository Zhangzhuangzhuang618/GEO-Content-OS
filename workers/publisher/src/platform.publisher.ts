import {
  BaijiahaoDeliveryAdapter,
  hashBaijiahaoPayload,
} from '@geo-content-os/adapter-platforms/baijiahao/delivery';
import {
  BAIJIAHAO_RENDER_RULE_VERSION,
  renderBaijiahao,
} from '@geo-content-os/adapter-platforms/baijiahao/render';
import {
  DouyinDeliveryAdapter,
  hashDouyinPayload,
} from '@geo-content-os/adapter-platforms/douyin/delivery';
import {
  DOUYIN_RENDER_RULE_VERSION,
  renderDouyin,
} from '@geo-content-os/adapter-platforms/douyin/render';
import {
  hashOfficialSitePayload,
  OfficialSiteDeliveryAdapter,
  OfficialSiteDeliveryError,
} from '@geo-content-os/adapter-platforms/official_site/delivery';
import {
  OFFICIAL_SITE_RENDER_RULE_VERSION,
  renderOfficialSite,
} from '@geo-content-os/adapter-platforms/official_site/render';
import type { ObjectStorageAdapter } from '@geo-content-os/adapter-storage';
import { createHash } from 'node:crypto';
import {
  hashToutiaoPayload,
  ToutiaoDeliveryAdapter,
} from '@geo-content-os/adapter-platforms/toutiao/delivery';
import {
  renderToutiao,
  TOUTIAO_RENDER_RULE_VERSION,
} from '@geo-content-os/adapter-platforms/toutiao/render';
import {
  hashWechatMpPayload,
  WechatMpDeliveryAdapter,
} from '@geo-content-os/adapter-platforms/wechat_mp/delivery';
import {
  renderWechatMp,
  WECHAT_MP_RENDER_RULE_VERSION,
} from '@geo-content-os/adapter-platforms/wechat_mp/render';
import {
  hashXiaohongshuPayload,
  XiaohongshuDeliveryAdapter,
} from '@geo-content-os/adapter-platforms/xiaohongshu/delivery';
import {
  renderXiaohongshu,
  XIAOHONGSHU_RENDER_RULE_VERSION,
} from '@geo-content-os/adapter-platforms/xiaohongshu/render';
import {
  hashZhihuPayload,
  ZhihuDeliveryAdapter,
} from '@geo-content-os/adapter-platforms/zhihu/delivery';
import {
  renderZhihu,
  ZHIHU_RENDER_RULE_VERSION,
} from '@geo-content-os/adapter-platforms/zhihu/render';

import { PublisherError } from './publisher.errors.js';
import type {
  BaijiahaoReconcileClaim,
  BaijiahaoRemoteStatus,
  PlatformDelivery,
  PublishClaim,
  PublisherPlatformPort,
} from './publisher.types.js';

interface RenderFailure {
  readonly issues: readonly { readonly code: string; readonly message: string }[];
  readonly ok: false;
}
interface RenderSuccess<TPayload> {
  readonly issues: readonly [];
  readonly ok: true;
  readonly payload: TPayload;
}
type RenderResult<TPayload> = RenderFailure | RenderSuccess<TPayload>;
type DeliveryResult =
  | {
      readonly mode: 'api';
      readonly publish: {
        readonly external_id: string;
        readonly published_at?: string;
        readonly status: 'processing' | 'published';
        readonly url: string | null;
      };
    }
  | { readonly export: unknown; readonly mode: 'export' };

export class SevenPlatformPublisher implements PublisherPlatformPort {
  public constructor(private readonly storage?: Pick<ObjectStorageAdapter, 'getObject'>) {}

  public async getBaijiahaoStatus(
    claim: BaijiahaoReconcileClaim,
    credential: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<BaijiahaoRemoteStatus> {
    const adapter = new BaijiahaoDeliveryAdapter(
      Object.freeze({ ...credential, account_id: claim.accountId, mode: 'api' }),
    );
    const result = await adapter.getStatus(claim.externalId, signal);
    return Object.freeze({
      externalId: result.external_id,
      status: result.status,
      url: result.url,
    });
  }

  public async deliver(
    claim: PublishClaim,
    credential: Readonly<Record<string, unknown>> | null,
    signal?: AbortSignal,
  ): Promise<PlatformDelivery> {
    const config = deliveryConfig(claim, credential);
    const content = platformRenderContent(claim.content);
    switch (claim.platformCode) {
      case 'official_site': {
        const adapter = new OfficialSiteDeliveryAdapter(config);
        const capabilities =
          claim.publishMode === 'api' ? await adapter.capabilities(signal) : undefined;
        if (capabilities && !capabilities.publish) {
          throw new OfficialSiteDeliveryError(
            'CAPABILITY_UNAVAILABLE',
            'Configured official site API does not currently support publication',
          );
        }
        const prepared = capabilities
          ? await prepareOfficialSiteMedia(
              claim,
              adapter,
              this.storage,
              capabilities.media_upload,
              signal,
            )
          : existingOfficialSiteMedia(claim.mediaAssets ?? []);
        const rendered = renderOfficialSite({
          citations: claim.citations,
          content,
          media_assets: prepared.assets,
          rule_version: OFFICIAL_SITE_RENDER_RULE_VERSION,
        });
        if (claim.publishMode !== 'api') {
          return execute(
            claim,
            signal,
            rendered,
            hashOfficialSitePayload,
            (input) => adapter.deliver(input, signal),
            prepared.diagnostics,
          );
        }
        return execute(
          claim,
          signal,
          rendered,
          hashOfficialSitePayload,
          async (input) => ({ mode: 'api', publish: await adapter.publish(input, signal) }),
          prepared.diagnostics,
        );
      }
      case 'baijiahao':
        return execute(
          claim,
          signal,
          renderBaijiahao({
            citations: claim.citations,
            content: baijiahaoContentWithMedia(content, claim.mediaAssets ?? []),
            rule_version: BAIJIAHAO_RENDER_RULE_VERSION,
          }),
          hashBaijiahaoPayload,
          (input) => new BaijiahaoDeliveryAdapter(config).deliver(input, signal),
        );
      case 'toutiao':
        return execute(
          claim,
          signal,
          renderToutiao({
            citations: claim.citations,
            content,
            rule_version: TOUTIAO_RENDER_RULE_VERSION,
          }),
          hashToutiaoPayload,
          (input) => new ToutiaoDeliveryAdapter(config).deliver(input, signal),
        );
      case 'zhihu':
        return execute(
          claim,
          signal,
          renderZhihu({
            citations: claim.citations,
            content,
            rule_version: ZHIHU_RENDER_RULE_VERSION,
          }),
          hashZhihuPayload,
          (input) => new ZhihuDeliveryAdapter(config).deliver(input, signal),
        );
      case 'xiaohongshu':
        return execute(
          claim,
          signal,
          renderXiaohongshu({
            citations: claim.citations,
            content,
            rule_version: XIAOHONGSHU_RENDER_RULE_VERSION,
          }),
          hashXiaohongshuPayload,
          (input) => new XiaohongshuDeliveryAdapter(config).deliver(input, signal),
        );
      case 'wechat_mp':
        return execute(
          claim,
          signal,
          renderWechatMp({
            citations: claim.citations,
            content,
            rule_version: WECHAT_MP_RENDER_RULE_VERSION,
          }),
          hashWechatMpPayload,
          (input) => new WechatMpDeliveryAdapter(config).deliver(input, signal),
        );
      case 'douyin':
        return execute(
          claim,
          signal,
          renderDouyin({
            citations: claim.citations,
            content,
            rule_version: DOUYIN_RENDER_RULE_VERSION,
          }),
          hashDouyinPayload,
          (input) => new DouyinDeliveryAdapter(config).deliver(input, signal),
        );
    }
  }
}

function platformRenderContent(
  content: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (content['schema_version'] !== 'content-writer-data@1') {
    throw new PublisherError(
      'PUBLISHER_RENDER_BLOCKED',
      'CONTENT_SCHEMA_UNSUPPORTED: Content version is not supported by this publisher',
    );
  }
  const renderContent = { ...content };
  delete renderContent['schema_version'];
  return Object.freeze(renderContent);
}

function baijiahaoContentWithMedia(
  content: Readonly<Record<string, unknown>>,
  assets: readonly NonNullable<PublishClaim['mediaAssets']>[number][],
): Readonly<Record<string, unknown>> {
  if (assets.length === 0) return content;
  const platformMeta = content['platform_meta'];
  if (typeof platformMeta !== 'object' || platformMeta === null || Array.isArray(platformMeta)) {
    return content;
  }
  const cover = assets.find((asset) => asset.role === 'cover');
  const body = assets.filter((asset) => asset.role === 'body').map((asset) => asset.id);
  return Object.freeze({
    ...content,
    platform_meta: Object.freeze({
      ...platformMeta,
      body_asset_ids: body,
      cover_asset_id: cover?.id ?? null,
    }),
  });
}

async function execute<TPayload>(
  claim: PublishClaim,
  signal: AbortSignal | undefined,
  rendered: RenderResult<TPayload>,
  hash: (payload: TPayload) => string,
  deliver: (input: {
    readonly content_version_id: string;
    readonly idempotency_key: string;
    readonly payload: TPayload;
    readonly payload_hash: string;
  }) => Promise<DeliveryResult>,
  responseDetails?: Readonly<Record<string, unknown>>,
): Promise<PlatformDelivery> {
  void signal;
  if (!rendered.ok) {
    const issue = rendered.issues[0];
    throw new PublisherError(
      'PUBLISHER_RENDER_BLOCKED',
      issue ? `${issue.code}: ${issue.message}` : 'Platform render was blocked',
    );
  }
  const payloadHash = hash(rendered.payload);
  const result = await deliver({
    content_version_id: claim.contentVersionId,
    idempotency_key: claim.idempotencyKey,
    payload: rendered.payload,
    payload_hash: payloadHash,
  });
  if (result.mode === 'export') {
    return Object.freeze({ bundle: result.export, mode: result.mode, payloadHash });
  }
  return Object.freeze({
    externalId: result.publish.external_id,
    mode: result.mode,
    payloadHash,
    response: Object.freeze({
      ...(result.publish.published_at ? { published_at: result.publish.published_at } : {}),
      ...(responseDetails ?? {}),
      status: result.publish.status,
    }),
    url: result.publish.url,
  });
}

interface PreparedOfficialSiteMedia {
  readonly assets: readonly {
    readonly alt_text: string;
    readonly position: number;
    readonly role: 'body' | 'cover';
    readonly url: string;
  }[];
  readonly diagnostics: Readonly<Record<string, unknown>>;
}

async function prepareOfficialSiteMedia(
  claim: PublishClaim,
  adapter: OfficialSiteDeliveryAdapter,
  storage: Pick<ObjectStorageAdapter, 'getObject'> | undefined,
  mediaUploadAvailable: boolean,
  signal?: AbortSignal,
): Promise<PreparedOfficialSiteMedia> {
  const sourceAssets = claim.mediaAssets ?? [];
  if (sourceAssets.length === 0) {
    return Object.freeze({ assets: Object.freeze([]), diagnostics: Object.freeze({}) });
  }
  if (!mediaUploadAvailable || !storage) {
    return Object.freeze({
      assets: existingOfficialSiteMedia(sourceAssets).assets,
      diagnostics: Object.freeze({
        media_upload: Object.freeze({
          available: mediaUploadAvailable && Boolean(storage),
          skipped: sourceAssets.length,
          uploaded: Object.freeze([]),
        }),
      }),
    });
  }
  const uploaded: { readonly asset_id: string; readonly url: string }[] = [];
  const publishedAssets: {
    readonly alt_text: string;
    readonly position: number;
    readonly role: 'body' | 'cover';
    readonly url: string;
  }[] = [];
  let skipped = 0;
  for (const asset of sourceAssets) {
    try {
      requireUploadableAsset(asset);
      const body = await storage.getObject(storageKey(asset.objectUri));
      if (body.byteLength !== asset.sizeBytes || sha256(body) !== asset.contentHash) {
        throw new Error('Stored image does not match its immutable metadata');
      }
      const result = await adapter.uploadMedia(
        {
          asset_id: asset.id,
          body,
          content_hash: asset.contentHash,
          content_type: 'image/jpeg',
          content_version_id: claim.contentVersionId,
          idempotency_key: `official-site-media:${asset.id}`,
          role: asset.role,
        },
        signal,
      );
      uploaded.push(Object.freeze({ asset_id: asset.id, url: result.url }));
      publishedAssets.push(
        Object.freeze({
          alt_text: asset.altText,
          position: asset.position,
          role: asset.role,
          url: result.url,
        }),
      );
    } catch (error) {
      skipped += 1;
      console.warn('Official site media upload skipped', {
        assetId: asset.id,
        code:
          error instanceof OfficialSiteDeliveryError
            ? error.code
            : 'MEDIA_ASSET_INVALID_OR_UNAVAILABLE',
        contentVersionId: claim.contentVersionId,
      });
      if (asset.publicUrl) {
        publishedAssets.push(
          Object.freeze({
            alt_text: asset.altText,
            position: asset.position,
            role: asset.role,
            url: asset.publicUrl,
          }),
        );
      }
    }
  }
  return Object.freeze({
    assets: Object.freeze(publishedAssets),
    diagnostics: Object.freeze({
      media_upload: Object.freeze({
        available: true,
        skipped,
        uploaded: Object.freeze(uploaded),
      }),
    }),
  });
}

function existingOfficialSiteMedia(
  assets: readonly NonNullable<PublishClaim['mediaAssets']>[number][],
): PreparedOfficialSiteMedia {
  return Object.freeze({
    assets: Object.freeze(
      assets
        .filter((asset) => asset.publicUrl !== null)
        .map((asset) =>
          Object.freeze({
            alt_text: asset.altText,
            position: asset.position,
            role: asset.role,
            url: asset.publicUrl as string,
          }),
        ),
    ),
    diagnostics: Object.freeze({}),
  });
}

function requireUploadableAsset(asset: NonNullable<PublishClaim['mediaAssets']>[number]): void {
  if (
    asset.mimeType !== 'image/jpeg' ||
    !Number.isSafeInteger(asset.sizeBytes) ||
    asset.sizeBytes < 1 ||
    asset.sizeBytes > 10_000_000 ||
    !/^[a-f0-9]{64}$/u.test(asset.contentHash)
  ) {
    throw new Error('Official site image metadata is invalid');
  }
}

function storageKey(uri: string): string {
  const match = /^(?:s3|memory):\/\/[^/]+\/(.+)$/u.exec(uri);
  if (!match?.[1]) throw new Error('Official site image object URI is invalid');
  const key = decodeURIComponent(match[1]);
  if (!key || key.startsWith('/') || key.includes('..')) {
    throw new Error('Official site image object key is invalid');
  }
  return key;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function deliveryConfig(
  claim: PublishClaim,
  credential: Readonly<Record<string, unknown>> | null,
): Readonly<Record<string, unknown>> {
  if (claim.publishMode !== 'api') return Object.freeze({ mode: 'export_only' });
  if (!credential) throw new PublisherError('PUBLISHER_AUTH_INVALID', 'Credential is required');
  return Object.freeze({
    ...credential,
    ...(claim.platformCode === 'baijiahao' ? { account_id: claim.accountId } : {}),
    mode: 'api',
  });
}
