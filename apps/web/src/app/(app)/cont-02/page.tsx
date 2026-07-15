import type { Metadata } from 'next';

import { BriefEditor } from '../../../features/cont-02/brief-editor';

export const metadata: Metadata = { title: 'Brief 编辑' };

export default function BriefEditorPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-5xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header>
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">内容生产</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">Brief 编辑</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          保存生产目标、受众、关键词、证据、平台和约束；事实型 Brief 必须绑定证据来源。
        </p>
      </header>
      <BriefEditor />
    </main>
  );
}
