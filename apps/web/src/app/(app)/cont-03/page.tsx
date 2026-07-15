import type { Metadata } from 'next';

import { ContentPackageList } from '../../../features/cont-03/content-package-list';

export const metadata: Metadata = { title: '内容包列表' };

export default function ContentPackageListPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header>
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">内容生产</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">内容包列表</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          查看质量、平台生产进度、负责人、已结算成本和更新时间，并进入内容包详情。
        </p>
      </header>
      <ContentPackageList />
    </main>
  );
}
