import type { Metadata } from 'next';

import { KeywordSetManager } from '../../../features/str-04/keyword-set-manager';

export const metadata: Metadata = { title: '关键词集' };

export default function KeywordSetPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header>
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">策略中心</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">关键词集</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          批量导入并维护关键词意图、优先级、同义词和平台范围；同一关键词集内 term
          忽略大小写后必须唯一。
        </p>
      </header>
      <KeywordSetManager />
    </main>
  );
}
