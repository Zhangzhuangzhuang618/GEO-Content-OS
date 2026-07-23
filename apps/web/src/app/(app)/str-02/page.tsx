import type { Metadata } from 'next';

import { BrandProfileEditor } from '../../../features/str-02/brand-profile-editor';

export const metadata: Metadata = { title: '品牌策略编辑' };

export default function BrandProfileEditorPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-5xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header className="mb-8">
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">策略中心</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">品牌策略编辑</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          每次保存都会创建不可覆盖的新草稿版本；已发布版本保持只读。
        </p>
      </header>
      <BrandProfileEditor />
    </main>
  );
}
