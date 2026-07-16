import type { Metadata } from 'next';

import { PublishJobDetailView } from '../../../features/pub-03/publish-job-detail';

export const metadata: Metadata = { title: '发布任务' };

export default function PublishJobPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header>
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">发布管理</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">发布任务</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          查看冻结 Payload、不可变尝试、平台结果和确定性导出包。
        </p>
      </header>
      <PublishJobDetailView />
    </main>
  );
}
