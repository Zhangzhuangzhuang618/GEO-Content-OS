export const PLATFORM_CODES = Object.freeze([
  'official_site',
  'baijiahao',
  'sohu',
  'toutiao',
  'zhihu',
  'xiaohongshu',
  'wechat_mp',
  'douyin',
] as const);

export type PlatformCode = (typeof PLATFORM_CODES)[number];

export const PLATFORM_DEFINITIONS = {
  official_site: {
    name: '官网',
    contentForm: 'SEO 长文/专题页',
    delivery: 'api_or_export',
  },
  baijiahao: {
    name: '百家号',
    contentForm: '图文/动态',
    delivery: 'capability_dependent',
  },
  sohu: {
    name: '搜狐号',
    contentForm: '图文',
    delivery: 'capability_dependent',
  },
  toutiao: {
    name: '头条号',
    contentForm: '图文/微头条',
    delivery: 'capability_dependent',
  },
  zhihu: {
    name: '知乎',
    contentForm: '回答/文章',
    delivery: 'capability_dependent',
  },
  xiaohongshu: {
    name: '小红书',
    contentForm: '笔记/图文',
    delivery: 'export_default',
  },
  wechat_mp: {
    name: '微信公众号',
    contentForm: '群发图文/长文',
    delivery: 'api_or_export',
  },
  douyin: {
    name: '抖音',
    contentForm: '口播脚本/分镜/字幕',
    delivery: 'export_default',
  },
} as const satisfies Record<
  PlatformCode,
  {
    name: string;
    contentForm: string;
    delivery: 'api_or_export' | 'capability_dependent' | 'export_default';
  }
>;
