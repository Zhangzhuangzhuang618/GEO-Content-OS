import type { Metadata } from 'next';

import { Dashboard } from '../../../features/dash-01/dashboard';

export const metadata: Metadata = { title: '工作台' };

export default function DashboardPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header className="mb-8">
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">
          GEO Content OS
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">开始创作</h1>
        <p className="mt-2 text-sm text-ink-500">
          从一个主题开始生成多平台内容，也可以继续处理最近任务。
        </p>
      </header>
      <Dashboard />
    </main>
  );
}
