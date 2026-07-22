import type { PlatformAccount, PlatformCode } from './platform-account.schema';

const DEFAULT_PUBLISHING_URLS: Readonly<Partial<Record<PlatformCode, string>>> = {
  baijiahao: 'https://baijiahao.baidu.com/builder/rc/edit?type=news',
  douyin: 'https://creator.douyin.com/creator-micro/content/upload',
  toutiao: 'https://mp.toutiao.com/profile_v4/graphic/publish',
  wechat_mp: 'https://mp.weixin.qq.com/',
  xiaohongshu: 'https://creator.xiaohongshu.com/publish/publish',
  zhihu: 'https://zhuanlan.zhihu.com/write',
};

export function resolvePublishingUrl(account: PlatformAccount): string | null {
  return safeHttpUrl(account.publishing_url ?? DEFAULT_PUBLISHING_URLS[account.platform_code]);
}

function safeHttpUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}
