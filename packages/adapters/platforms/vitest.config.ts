import { createNodeVitestConfig } from '../../testkit/vitest/node.mjs';

export default createNodeVitestConfig({
  include: [
    '{baijiahao,douyin,lieju,official_site,sohu,toutiao,wechat_mp,xiaohongshu,zhihu}/**/*.test.ts',
  ],
});
