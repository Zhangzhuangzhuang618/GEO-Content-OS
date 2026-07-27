'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { AccountMenu } from './account-menu';

const NAVIGATION = [
  { href: '/dash-01', label: '首页', prefixes: ['/dash-01'] },
  { href: '/cont-03', label: '内容创作', prefixes: ['/cont-', '/qual-'] },
  { href: '/str-01', label: '品牌与选题', prefixes: ['/str-'] },
  { href: '/rev-01', label: '待办审核', prefixes: ['/rev-'] },
  { href: '/pub-02', label: '发布管理', prefixes: ['/pub-'] },
  { href: '/know-01', label: '企业资料', prefixes: ['/know-'] },
  { href: '/anl-01', label: '数据', prefixes: ['/anl-'] },
  { href: '/set-02', label: '设置', prefixes: ['/set-', '/plat-'] },
] as const;

const SECONDARY_NAVIGATION = [
  {
    ariaLabel: '内容创作功能',
    matchPrefixes: ['/cont-', '/qual-'],
    items: [
      {
        href: '/cont-03',
        label: '内容列表',
        prefixes: ['/cont-03', '/cont-04', '/cont-05', '/cont-06', '/qual-01'],
      },
      { href: '/cont-01', label: '内容需求', prefixes: ['/cont-01'] },
      { href: '/cont-02', label: '新建内容需求', prefixes: ['/cont-02'] },
    ],
  },
  {
    ariaLabel: '品牌与选题功能',
    matchPrefixes: ['/str-'],
    items: [
      { href: '/str-01', label: '品牌策略', prefixes: ['/str-01', '/str-02'] },
      { href: '/str-04', label: '关键词管理', prefixes: ['/str-04'] },
      { href: '/str-03', label: '选题规划', prefixes: ['/str-03'] },
    ],
  },
  {
    ariaLabel: '审核功能',
    matchPrefixes: ['/rev-'],
    items: [{ href: '/rev-01', label: '待审核内容', prefixes: ['/rev-01', '/rev-02'] }],
  },
  {
    ariaLabel: '发布管理功能',
    matchPrefixes: ['/pub-'],
    items: [
      { href: '/pub-02', label: '发布任务', prefixes: ['/pub-02', '/pub-03'] },
      { href: '/pub-01', label: '平台账号', prefixes: ['/pub-01'] },
    ],
  },
  {
    ariaLabel: '企业资料功能',
    matchPrefixes: ['/know-'],
    items: [
      { href: '/know-01', label: '资料列表', prefixes: ['/know-01', '/know-03'] },
      { href: '/know-02', label: '导入资料', prefixes: ['/know-02'] },
      { href: '/know-04', label: '事实裁决', prefixes: ['/know-04'] },
    ],
  },
  {
    ariaLabel: '数据功能',
    matchPrefixes: ['/anl-'],
    items: [
      { href: '/anl-01', label: '数据总览', prefixes: ['/anl-01'] },
      { href: '/anl-03', label: 'AI 可见度', prefixes: ['/anl-03'] },
      { href: '/anl-02', label: '指标导入', prefixes: ['/anl-02'] },
      { href: '/anl-04', label: '成本中心', prefixes: ['/anl-04'] },
    ],
  },
  {
    ariaLabel: '设置功能',
    matchPrefixes: ['/set-', '/plat-'],
    items: [
      { href: '/set-02', label: '工作区', prefixes: ['/set-02'] },
      { href: '/set-01', label: '成员与权限', prefixes: ['/set-01'] },
      { href: '/set-04', label: '操作日志', prefixes: ['/set-04'] },
      { href: '/set-03', label: 'AI 与平台规则（平台运营）', prefixes: ['/set-03'] },
      { href: '/plat-01', label: '企业管理（平台管理员）', prefixes: ['/plat-01'] },
    ],
  },
] as const;

export function AppShell({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname();
  const secondaryNavigation = SECONDARY_NAVIGATION.find((section) =>
    section.matchPrefixes.some((prefix) => pathname.startsWith(prefix)),
  );

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-line/80 bg-white/95 backdrop-blur">
        <div className="mx-auto flex min-h-16 w-full max-w-7xl items-center gap-3 px-4 sm:px-8">
          <Link
            aria-label="返回首页"
            className="shrink-0 font-semibold tracking-tight text-ink-950"
            href="/dash-01"
          >
            <span className="hidden sm:inline">GEO Content OS</span>
            <span className="sm:hidden">GEO</span>
          </Link>
          <nav aria-label="主导航" className="hidden min-w-0 flex-1 overflow-x-auto lg:block">
            <ul className="flex min-w-max items-center gap-1">
              {NAVIGATION.map((item) => {
                const active = item.prefixes.some((prefix) => pathname.startsWith(prefix));
                return (
                  <li key={item.href}>
                    <Link
                      aria-current={active ? 'page' : undefined}
                      className={`inline-flex min-h-10 items-center rounded-control px-2.5 text-sm font-medium ${
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
          <div className="min-w-0 flex-1 lg:hidden" />
          <Link
            className="hidden min-h-10 shrink-0 items-center rounded-control bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 md:inline-flex"
            href="/dash-01#create-content"
          >
            创建内容
          </Link>
          <AccountMenu />
        </div>
        <nav
          aria-label="移动端主导航"
          className="overflow-x-auto border-t border-line/70 px-4 lg:hidden"
        >
          <ul className="mx-auto flex min-w-max items-center gap-1 py-1">
            {NAVIGATION.map((item) => {
              const active = item.prefixes.some((prefix) => pathname.startsWith(prefix));
              return (
                <li key={item.href}>
                  <Link
                    aria-current={active ? 'page' : undefined}
                    className={`flex min-h-10 items-center rounded-control px-3 text-sm font-medium ${
                      active ? 'bg-brand-50 text-brand-700' : 'text-ink-600 hover:bg-surface-subtle'
                    }`}
                    href={item.href}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
            <li>
              <Link
                className="flex min-h-10 items-center rounded-control bg-brand-600 px-3 text-sm font-semibold text-white"
                href="/dash-01#create-content"
              >
                创建内容
              </Link>
            </li>
          </ul>
        </nav>
        {secondaryNavigation ? (
          <nav
            aria-label={secondaryNavigation.ariaLabel}
            className="overflow-x-auto border-t border-line/70 px-4"
          >
            <ul className="mx-auto flex w-full max-w-7xl min-w-max items-center gap-2 py-2 sm:px-4">
              {secondaryNavigation.items.map((item) => {
                const active = item.prefixes.some((prefix) => pathname.startsWith(prefix));
                return (
                  <li key={`${item.href}-${item.label}`}>
                    <Link
                      aria-current={active ? 'page' : undefined}
                      className={`flex min-h-9 items-center rounded-control px-3 text-sm font-medium ${
                        active
                          ? 'bg-brand-50 text-brand-700'
                          : 'text-ink-600 hover:bg-surface-subtle'
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
        ) : null}
      </header>
      {children}
    </div>
  );
}
