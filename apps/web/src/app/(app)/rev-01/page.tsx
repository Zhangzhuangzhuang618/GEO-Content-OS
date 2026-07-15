import type { Metadata } from 'next';

import { ReviewInbox } from '../../../features/rev-01/review-inbox';

export const metadata: Metadata = { title: '审核队列' };

export default function ReviewInboxPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header>
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">
          审核工作台
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">审核队列</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          仅展示当前账号获授权工作区内的冻结快照；领取时设置风险与截止时间。
        </p>
      </header>
      <ReviewInbox />
    </main>
  );
}
