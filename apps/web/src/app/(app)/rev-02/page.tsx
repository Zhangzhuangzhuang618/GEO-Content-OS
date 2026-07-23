import type { Metadata } from 'next';
import { ReviewSnapshot } from '../../../features/rev-02/review-snapshot';

export const metadata: Metadata = { title: '审核快照' };
export default function ReviewSnapshotPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header>
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">内容审核</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">审核详情</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          按平台核对内容、质量和事实依据，确认无误后通过，发现问题则退回修改。
        </p>
      </header>
      <ReviewSnapshot />
    </main>
  );
}
