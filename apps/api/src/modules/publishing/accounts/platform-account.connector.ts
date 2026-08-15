import { BaijiahaoDeliveryAdapter } from '@geo-content-os/adapter-platforms/baijiahao/delivery';
import { DouyinDeliveryAdapter } from '@geo-content-os/adapter-platforms/douyin/delivery';
import { OfficialSiteDeliveryAdapter } from '@geo-content-os/adapter-platforms/official_site/delivery';
import { SohuDeliveryAdapter } from '@geo-content-os/adapter-platforms/sohu/delivery';
import { LiejuDeliveryAdapter } from '@geo-content-os/adapter-platforms/lieju/delivery';
import { ToutiaoDeliveryAdapter } from '@geo-content-os/adapter-platforms/toutiao/delivery';
import { WechatMpDeliveryAdapter } from '@geo-content-os/adapter-platforms/wechat_mp/delivery';
import { XiaohongshuDeliveryAdapter } from '@geo-content-os/adapter-platforms/xiaohongshu/delivery';
import { ZhihuDeliveryAdapter } from '@geo-content-os/adapter-platforms/zhihu/delivery';

import { PlatformAccountError } from './platform-account.errors.js';
import type { AccountCredentialProbe, PlatformAccountConnector } from './platform-account.types.js';

export class PlatformDeliveryAccountConnector implements PlatformAccountConnector {
  public probe(
    input: Parameters<PlatformAccountConnector['probe']>[0],
  ): Promise<AccountCredentialProbe> {
    return this.capabilities(input.platformCode, input.publishMode, input.credential);
  }

  public refresh(
    input: Parameters<PlatformAccountConnector['refresh']>[0],
  ): Promise<AccountCredentialProbe> {
    return this.capabilities(input.platformCode, 'api', input.credential);
  }

  private async capabilities(
    platformCode: Parameters<PlatformAccountConnector['probe']>[0]['platformCode'],
    publishMode: Parameters<PlatformAccountConnector['probe']>[0]['publishMode'],
    credential: Readonly<Record<string, unknown>> | null,
  ): Promise<AccountCredentialProbe> {
    try {
      const config =
        publishMode === 'api' ? { ...(credential ?? {}), mode: 'api' } : { mode: 'export_only' };
      const adapter = deliveryAdapter(platformCode, config);
      const capabilities = await adapter.capabilities();
      const deliveryMethod =
        platformCode === 'lieju' && credential?.['delivery_method'] === 'official_api'
          ? 'official_api'
          : platformCode === 'lieju'
            ? 'browser_gateway'
            : undefined;
      return Object.freeze({
        capabilities: Object.freeze({
          ...capabilities,
          ...(deliveryMethod ? { delivery_method: deliveryMethod } : {}),
        }),
        providerAccountId: null,
        publishMode,
        scopes: Object.freeze([]),
        status: publishMode === 'api' && !capabilities.publish ? 'reauth' : 'active',
        tokenExpiresAt: null,
      });
    } catch {
      throw new PlatformAccountError(
        'PLATFORM_ACCOUNT_CREDENTIAL_INVALID',
        'Platform account credential is invalid',
      );
    }
  }
}

function deliveryAdapter(
  platformCode: Parameters<PlatformAccountConnector['probe']>[0]['platformCode'],
  config: unknown,
) {
  switch (platformCode) {
    case 'official_site':
      return new OfficialSiteDeliveryAdapter(config);
    case 'baijiahao':
      return new BaijiahaoDeliveryAdapter(config);
    case 'sohu':
      return new SohuDeliveryAdapter(config);
    case 'lieju':
      return new LiejuDeliveryAdapter(config);
    case 'toutiao':
      return new ToutiaoDeliveryAdapter(config);
    case 'zhihu':
      return new ZhihuDeliveryAdapter(config);
    case 'xiaohongshu':
      return new XiaohongshuDeliveryAdapter(config);
    case 'wechat_mp':
      return new WechatMpDeliveryAdapter(config);
    case 'douyin':
      return new DouyinDeliveryAdapter(config);
  }
}
