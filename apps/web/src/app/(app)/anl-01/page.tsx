import type { Metadata } from 'next';
import { AnalyticsOverview } from '../../../features/anl-01/analytics-overview';
export const metadata: Metadata = { title: '数据总览' };
export default function AnalyticsOverviewPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header>
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">数据分析</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">数据总览</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          统一查看曝光、阅读、互动、转化、可见性和已结算成本。
        </p>
      </header>
      <AnalyticsOverview />
    </main>
  );
}
