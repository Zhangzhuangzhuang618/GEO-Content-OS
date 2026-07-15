import type { Metadata } from 'next';

import { ContentPackageDetail } from '../../../features/cont-04/content-package-detail';

export const metadata: Metadata = { title: '内容包详情' };

export default function ContentPackageDetailPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header>
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">内容生产</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">内容包详情</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          追踪母稿、平台变体、生成运行、引用、版本、审核和发布状态。
        </p>
      </header>
      <ContentPackageDetail />
    </main>
  );
}
