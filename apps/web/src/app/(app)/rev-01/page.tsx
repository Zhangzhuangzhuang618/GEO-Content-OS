import type { Metadata } from 'next';

import { ReviewInbox } from '../../../features/rev-01/review-inbox';

export const metadata: Metadata = { title: '待审核内容' };

export default function ReviewInboxPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header>
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">内容审核</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">待审核内容</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          选择一条内容开始审核，确认无误后通过；需要修改时直接退回并说明原因。
        </p>
      </header>
      <ReviewInbox />
    </main>
  );
}
