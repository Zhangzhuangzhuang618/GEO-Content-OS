import type { Metadata } from 'next';
import { MetricsImportManager } from '../../../features/anl-02/metrics-import-manager';
export const metadata: Metadata = { title: '指标导入' };
export default function MetricsImportPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header>
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">数据分析</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">指标导入</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          选择 CSV 列并预览数据，确认无误后导入，同时保留可撤销的操作记录。
        </p>
      </header>
      <MetricsImportManager />
    </main>
  );
}
