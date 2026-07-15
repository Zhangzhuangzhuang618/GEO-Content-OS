import type { Metadata } from 'next';

import { TopicPlanning } from '../../../features/str-03/topic-planning';

export const metadata: Metadata = { title: '选题规划' };

export default function TopicPlanningPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header>
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">策略中心</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">选题规划</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          根据问题、意图、实体和证据规划选题；无证据选题必须先补充依据才能采纳。
        </p>
      </header>
      <TopicPlanning />
    </main>
  );
}
