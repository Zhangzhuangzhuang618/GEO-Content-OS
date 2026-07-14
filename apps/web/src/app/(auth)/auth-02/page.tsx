import type { Metadata } from 'next';

import { TenantSelector } from '../../../features/auth-02/tenant-selector';

export const metadata: Metadata = {
  title: '选择租户',
};

export default function TenantSelectionPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-5xl px-5 py-10 sm:px-8 sm:py-16"
      id="main-content"
    >
      <header className="mx-auto max-w-2xl text-center">
        <p className="text-sm font-semibold tracking-[0.18em] text-brand-600 uppercase">
          GEO Content OS
        </p>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight text-ink-950 sm:text-4xl">
          选择要进入的企业
        </h1>
        <p className="mt-3 text-base leading-7 text-ink-500">
          你的权限、工作区和内容数据将随当前企业切换。
        </p>
      </header>

      <TenantSelector />
    </main>
  );
}
