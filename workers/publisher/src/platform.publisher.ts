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
} from '@geo-content-os/adapter-platforms/official_site/delivery';
import {
  OFFICIAL_SITE_RENDER_RULE_VERSION,
  renderOfficialSite,
} from '@geo-content-os/adapter-platforms/official_site/render';
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

  public deliver(
    claim: PublishClaim,
    credential: Readonly<Record<string, unknown>> | null,
    signal?: AbortSignal,
  ): Promise<PlatformDelivery> {
    const config = deliveryConfig(claim, credential);
    const content = platformRenderContent(claim.content);
    switch (claim.platformCode) {
      case 'official_site':
        return execute(
          claim,
          signal,
          renderOfficialSite({
            citations: claim.citations,
            content,
            rule_version: OFFICIAL_SITE_RENDER_RULE_VERSION,
          }),
          hashOfficialSitePayload,
          (input) => new OfficialSiteDeliveryAdapter(config).deliver(input, signal),
        );
      case 'baijiahao':
        return execute(
          claim,
          signal,
          renderBaijiahao({
            citations: claim.citations,
            content,
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
      status: result.publish.status,
    }),
    url: result.publish.url,
  });
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
