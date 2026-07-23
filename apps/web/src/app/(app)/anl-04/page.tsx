import type { Metadata } from 'next';
import { CostCenter } from '../../../features/anl-04/cost-center';

export const metadata: Metadata = { title: '成本中心' };

export default function CostCenterPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header>
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">数据分析</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">成本中心</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          按企业、工作区、处理步骤和生成方式查看已结算成本，核对预算与供应商账单。
        </p>
      </header>
      <CostCenter />
    </main>
  );
}
