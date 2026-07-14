import type { Metadata } from 'next';

import { SourceList } from '../../../features/know-01/source-list';

export const metadata: Metadata = { title: '资料列表' };

export default function SourceListPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">知识库</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">资料列表</h1>
          <p className="mt-2 text-sm leading-6 text-ink-500">
            管理可追溯资料、可信级别、有效期和解析状态。
          </p>
        </div>
      </header>
      <SourceList />
    </main>
  );
}
