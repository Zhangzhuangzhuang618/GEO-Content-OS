import type { Metadata } from 'next';

import { ContentEditor } from '../../../features/cont-05/content-editor';

export const metadata: Metadata = { title: '内容编辑器' };

export default function ContentEditorPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header>
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">内容生产</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">内容编辑器</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          编辑结构化内容、维护段落锁，并追踪引用、质量和不可变版本历史。
        </p>
      </header>
      <ContentEditor />
    </main>
  );
}
