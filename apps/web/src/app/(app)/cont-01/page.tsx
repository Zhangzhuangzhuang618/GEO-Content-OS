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
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">Brief 列表</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          按项目、平台、目标和负责人查找生产 Brief，并从已有 Brief 创建副本。
        </p>
      </header>
      <BriefList />
    </main>
  );
}
