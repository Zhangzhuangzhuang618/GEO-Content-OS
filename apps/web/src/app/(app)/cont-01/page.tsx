import type { Metadata } from 'next';

import { BriefList } from '../../../features/cont-01/brief-list';

export const metadata: Metadata = { title: 'Brief 列表' };

export default function BriefListPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header>
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">内容生产</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">内容需求</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          按平台和目标查找内容需求，也可以从已有需求创建副本。
        </p>
      </header>
      <BriefList />
    </main>
  );
}
