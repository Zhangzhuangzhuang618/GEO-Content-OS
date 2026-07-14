import type { Metadata } from 'next';
import { FactAdjudication } from '../../../features/know-04/fact-adjudication';

export const metadata: Metadata = { title: '事实裁决' };

export default function FactAdjudicationPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-6xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header>
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">知识库</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">事实裁决</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          核对竞争值与原始证据，并通过审计保留的裁决动作更新事实状态。
        </p>
      </header>
      <FactAdjudication />
    </main>
  );
}
