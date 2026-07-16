import type { Metadata } from 'next';

import { AuditLog } from '../../../features/set-04/audit-log';

export const metadata: Metadata = { title: '审计日志' };

export default function AuditLogPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header>
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">系统设置</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">审计日志</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          查看当前租户不可变的 Actor、Action、资源、变更前后值、Request ID、IP 和时间。
        </p>
      </header>
      <AuditLog />
    </main>
  );
}
