import type { Metadata } from 'next';

import { PlatformTenantManager } from '../../../features/plat-01/platform-tenant-manager';

export const metadata: Metadata = { title: '企业管理' };

export default function PlatformTenantPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header className="mb-8">
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">平台运营</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">企业管理</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          创建、暂停和恢复企业账号，查看套餐、汇总用量与运行状态。
        </p>
      </header>
      <PlatformTenantManager />
    </main>
  );
}
