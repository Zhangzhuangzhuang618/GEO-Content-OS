'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { AccountMenu } from './account-menu';

const NAVIGATION = [
  { href: '/dash-01', label: '工作台', prefixes: ['/dash-01'] },
  { href: '/cont-03', label: '内容', prefixes: ['/cont-'] },
  { href: '/str-01', label: '策略', prefixes: ['/str-'] },
  { href: '/rev-01', label: '审核', prefixes: ['/rev-'] },
  { href: '/pub-02', label: '发布', prefixes: ['/pub-'] },
  { href: '/know-01', label: '知识库', prefixes: ['/know-'] },
  { href: '/anl-01', label: '数据分析', prefixes: ['/anl-'] },
  { href: '/set-02', label: '设置', prefixes: ['/set-'] },
] as const;

export function AppShell({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-line/80 bg-white/95 backdrop-blur">
        <div className="mx-auto flex min-h-16 w-full max-w-7xl items-center gap-5 px-5 sm:px-8">
          <Link className="shrink-0 font-semibold tracking-tight text-ink-950" href="/dash-01">
            GEO Content OS
          </Link>
          <nav aria-label="主导航" className="min-w-0 flex-1 overflow-x-auto">
            <ul className="flex min-w-max items-center gap-1">
              {NAVIGATION.map((item) => {
                const active = item.prefixes.some((prefix) => pathname.startsWith(prefix));
                return (
                  <li key={item.href}>
                    <Link
                      aria-current={active ? 'page' : undefined}
                      className={`inline-flex min-h-10 items-center rounded-control px-3 text-sm font-medium ${
                        active
                          ? 'bg-brand-50 text-brand-700'
                          : 'text-ink-500 hover:bg-surface-subtle hover:text-ink-950'
                      }`}
                      href={item.href}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
          <Link
            className="hidden min-h-10 shrink-0 items-center rounded-control bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 sm:inline-flex"
            href="/dash-01#create-content"
          >
            创建内容
          </Link>
          <AccountMenu />
        </div>
      </header>
      {children}
    </div>
  );
}
