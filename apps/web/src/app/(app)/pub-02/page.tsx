import type { Metadata } from 'next';
import Link from 'next/link';

import { PublishingCalendar } from '../../../features/pub-02/publishing-calendar';

export const metadata: Metadata = { title: '发布管理' };

export default function PublishingCalendarPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">
            发布管理
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">发布管理</h1>
          <p className="mt-2 text-sm leading-6 text-ink-500">
            从待发布内容中选择文章，安排立即发布或指定发布时间，并查看已有发布任务。
          </p>
        </div>
        <Link
          className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-control border border-line bg-white px-4 text-sm font-semibold text-ink-700 hover:bg-surface-subtle"
          href="/pub-01"
        >
          管理平台账号
        </Link>
      </header>
      <PublishingCalendar />
    </main>
  );
}
