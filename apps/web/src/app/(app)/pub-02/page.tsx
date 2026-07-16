import type { Metadata } from 'next';

import { PublishingCalendar } from '../../../features/pub-02/publishing-calendar';

export const metadata: Metadata = { title: '发布日历' };

export default function PublishingCalendarPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header>
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">发布管理</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">发布日历</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          查看七个平台的发布排期；只有 approved 变体可创建新任务。
        </p>
      </header>
      <PublishingCalendar />
    </main>
  );
}
