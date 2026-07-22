import type { Metadata } from 'next';

import { ContentPackageDetail } from '../../../features/cont-04/content-package-detail';

export const metadata: Metadata = { title: '内容详情' };

export default function ContentPackageDetailPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header>
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">内容生产</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">内容详情</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          查看通用初稿、各平台内容、事实依据、审核和发布进度。
        </p>
      </header>
      <ContentPackageDetail />
    </main>
  );
}
