'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantChoice } from '../auth-02/tenant.schema';
import { getAccountSession, logoutCurrentSession, type AccountSession } from './account-api';

export function AccountMenu() {
  const pathname = usePathname();
  const [session, setSession] = useState<AccountSession | null>(null);
  const [tenants, setTenants] = useState<readonly TenantChoice[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      getAccountSession(controller.signal),
      listAvailableTenants(controller.signal),
    ])
      .then(([loadedSession, loadedTenants]) => {
        setSession(loadedSession);
        setTenants(loadedTenants);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const tenant = tenants.find((item) => item.id === session?.active_tenant_id);
  const returnTo =
    typeof window === 'undefined' ? pathname : `${pathname}${window.location.search}`;
  const switchHref = `/auth-02?${new URLSearchParams({ return_to: returnTo })}`;

  async function leave(reason: 'logged_out' | 'switch_account') {
    if (busy) return;
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('登录状态已失效，请重新登录。');
      window.location.assign(`/auth-01?reason=${reason}`);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await logoutCurrentSession(csrf);
      const query = new URLSearchParams({ reason });
      if (reason === 'switch_account') query.set('return_to', returnTo);
      window.location.assign(`/auth-01?${query}`);
    } catch {
      setMessage('暂时无法退出，请检查网络后重试。');
      setBusy(false);
    }
  }

  return (
    <details className="group relative shrink-0">
      <summary
        aria-label="打开账号与企业菜单"
        className="flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-control border border-line bg-white px-3 text-sm font-medium text-ink-700 hover:bg-surface-subtle"
      >
        <span className="hidden max-w-32 truncate lg:inline">{tenant?.name ?? '当前企业'}</span>
        <span className="flex size-7 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">
          {initial(session?.user.display_name)}
        </span>
        <span aria-hidden="true" className="text-xs text-ink-500">
          ▾
        </span>
      </summary>
      <div className="absolute right-0 z-50 mt-2 w-72 rounded-2xl border border-line bg-white p-3 shadow-panel">
        <div className="border-b border-line px-2 pb-3">
          <p className="truncate font-semibold text-ink-950">
            {session?.user.display_name ?? '当前账号'}
          </p>
          <p className="mt-1 truncate text-xs text-ink-500">
            {session?.user.email ?? '正在读取账号信息'}
          </p>
          <p className="mt-2 truncate text-sm text-ink-700">企业：{tenant?.name ?? '当前企业'}</p>
        </div>
        <div className="mt-2 grid gap-1">
          <Link className={menuItem} href={switchHref}>
            切换企业
          </Link>
          <button
            className={menuButton}
            disabled={busy}
            onClick={() => void leave('switch_account')}
            type="button"
          >
            切换账号
          </button>
          <button
            className={`${menuButton} text-red-700`}
            disabled={busy}
            onClick={() => void leave('logged_out')}
            type="button"
          >
            {busy ? '正在退出…' : '退出登录'}
          </button>
        </div>
        {message ? (
          <p className="mt-2 rounded-control bg-red-50 p-2 text-xs text-red-800">{message}</p>
        ) : null}
      </div>
    </details>
  );
}

function initial(value: string | undefined) {
  return value?.trim().slice(0, 1).toLocaleUpperCase('zh-CN') || '我';
}

function readCookie(name: string) {
  const entry = document.cookie.split('; ').find((value) => value.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
}

const menuItem =
  'flex min-h-10 items-center rounded-control px-3 text-sm text-ink-700 hover:bg-surface-subtle';
const menuButton =
  'flex min-h-10 w-full items-center rounded-control px-3 text-left text-sm text-ink-700 hover:bg-surface-subtle disabled:opacity-50';
