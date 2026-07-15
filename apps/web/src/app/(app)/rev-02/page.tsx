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
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">冻结审核</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">审核快照</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          基于冻结版本、规则、Prompt、模型与引用逐变体决策；服务端在动作前复核全部 hash。
        </p>
      </header>
      <ReviewSnapshot />
    </main>
  );
}
