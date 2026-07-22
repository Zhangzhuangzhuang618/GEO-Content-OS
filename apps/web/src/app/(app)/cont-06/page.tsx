import type { Metadata } from 'next';

import { GenerationRunDetail } from '../../../features/cont-06/generation-run-detail';

export const metadata: Metadata = { title: '生成详情' };

export default function GenerationRunPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header>
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">内容生产</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">生成详情</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          查看内容生成进度、费用和事实依据，并处理取消或失败重试。
        </p>
      </header>
      <GenerationRunDetail />
    </main>
  );
}
