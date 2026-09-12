import type postgres from 'postgres';

export interface RegionalSlot {
  readonly slot: number;
  readonly district: string;
}

export function supportsGuangzhouTopic(term: string, region?: string | null): boolean {
  if (/^(?:佛山|东莞|深圳|珠海|惠州|中山|江门|肇庆|北京|上海|天津|重庆)(?:市)?/u.test(term.trim()))
    return false;
  if (!region || /^(?:通用(?:\/无地域)?|无地域|全国|广东省?)$/u.test(region)) return true;
  return /^(?:广州市?)?(?:(?:越秀|海珠|荔湾|天河|白云|黄埔|番禺|花都|南沙|从化|增城)区?)?$/u.test(
    region.trim(),
  );
}

/** Caller holds the batch/policy lock; retired candidates release their original slot. */
export async function nextRegionalSlot(
  tx: postgres.TransactionSql,
  batch: { id: string; tenantId: string },
  platform: string,
): Promise<RegionalSlot | null> {
  if (!['official_site', 'lieju', 'douyin'].includes(platform)) return null;
  const prefix = platform === 'official_site' ? 'official_site' : 'browser_platform';
  const [plan] = await tx<{ id: string; districts: string[] }[]>`
    SELECT p.id,p.districts FROM ${tx(prefix + '_daily_batches')} b
    JOIN regional_daily_plans p ON p.id=b.regional_plan_id AND p.tenant_id=b.tenant_id
    WHERE b.id=${batch.id}::uuid AND b.tenant_id=${batch.tenantId}::uuid`;
  if (!plan) return null;
  const used = await tx<{ slot: number }[]>`
    SELECT i.regional_slot AS slot FROM ${tx(prefix + '_daily_batch_items')} i
    JOIN ${tx(prefix + '_daily_batches')} b ON b.id=i.batch_id AND b.tenant_id=i.tenant_id
    WHERE b.regional_plan_id=${plan.id}::uuid AND b.tenant_id=${batch.tenantId}::uuid
      AND i.status<>'retired' AND i.regional_slot IS NOT NULL`;
  const slot = plan.districts.findIndex((_, index) => !used.some((row) => row.slot === index + 1));
  if (slot < 0) throw new Error('区域日批名额已用完');
  return { slot: slot + 1, district: plan.districts[slot]! };
}

export function regionalKeyword(term: string, district: string): string {
  const text = term.trim();
  // Only derived topic text is transformed, never enterprise names, addresses or source documents.
  return (
    district +
    text
      .replace(/^(?:广东省?)?(?:广州市?)?/u, '')
      .replace(/^(?:越秀|海珠|荔湾|天河|白云|黄埔|番禺|花都|南沙|从化|增城)区?/u, '')
  );
}

export function regionalInstructions(region: RegionalSlot | null, topic = ''): string {
  const serviceMeaning = /日式/u.test(topic)
    ? '保持原服务含义：“半日式”是日式搬迁的服务档位，不是半日或半天完成；不能按时长解释套餐或承诺工期。具体项目按服务资料描述，不把已包含的整理打包改成客户必须自行完成。'
    : '';
  return region
    ? `本篇目标区域为广州${region.district}区。标题必须包含${region.district}，正文、FAQ及图卡围绕该区用户的当前需求。企业全称、证照及真实地址原样保留，不把企业地址改成目标区。地区只限定服务对象：当地特征、网点、价格和案例必须来自输入资料；现场条件写成预约时需确认的具体事项。正文只写相关服务和预约动作，不解释写作约束，不引入无关套餐。${serviceMeaning}`
    : '';
}
