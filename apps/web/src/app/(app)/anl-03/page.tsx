import type { Metadata } from 'next';
import { VisibilityManager } from '../../../features/anl-03/visibility-manager';

export const metadata: Metadata = { title: '可见性观察' };
export default function VisibilityPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header>
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">数据分析</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">可见性观察</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          录入或批量导入查询排名与引用结果，以对象存储保留截图证据并查看趋势。
        </p>
      </header>
      <VisibilityManager />
    </main>
  );
}
