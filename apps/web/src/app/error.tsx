'use client';

import { useEffect } from 'react';

export interface RouteErrorProps {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}

export default function RouteError({ error, reset }: RouteErrorProps) {
  useEffect(() => {
    console.error('Web route rendering failed.', error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl items-center px-6" id="main-content">
      <section className="w-full rounded-2xl border border-line bg-white p-8 text-center shadow-panel">
        <p className="text-sm font-semibold text-brand-600">页面暂时不可用</p>
        <h1 className="mt-3 text-2xl font-semibold text-ink-950">加载内容时出现问题</h1>
        <p className="mt-3 text-sm leading-6 text-ink-500">
          请重试；若问题持续发生，请联系系统管理员。
        </p>
        <button
          className="mt-7 rounded-control bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700"
          onClick={reset}
          type="button"
        >
          重新加载
        </button>
      </section>
    </main>
  );
}
