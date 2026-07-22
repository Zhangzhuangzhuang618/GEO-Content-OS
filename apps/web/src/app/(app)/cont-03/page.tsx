import type { Metadata } from 'next';

import { ContentPackageList } from '../../../features/cont-03/content-package-list';

export const metadata: Metadata = { title: '我的内容' };

export default function ContentPackageListPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header>
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">内容中心</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">我的内容</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-500">
          按主题查看每份内容的生成进度、质量和下一步操作。平台适配稿都收在对应主题中。
        </p>
      </header>
      <ContentPackageList />
    </main>
  );
}
