import type { Metadata } from 'next';

import { SourceDetail } from '../../../features/know-03/source-detail';

export const metadata: Metadata = { title: '资料详情' };

export default function SourceDetailPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header>
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">知识库</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">资料详情</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          查看资料元数据、解析过程、分块原文、事实与引用回溯信息。
        </p>
      </header>
      <SourceDetail />
    </main>
  );
}
