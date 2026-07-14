'use client';

import { useCallback, useEffect, useState } from 'react';

import { listAvailableTenants, switchTenant, TenantRequestError } from './tenant-api';
import type { TenantChoice, TenantRole } from './tenant.schema';

const ROLE_LABELS: Readonly<Record<TenantRole, string>> = {
  analyst: '分析师',
  content_editor: '内容编辑',
  publisher: '发布人',
  reviewer: '审核人',
  strategy_editor: '策略编辑',
  tenant_admin: '租户管理员',
  tenant_owner: '租户所有者',
  viewer: '只读成员',
};

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly tenants: readonly TenantChoice[] }
  | { readonly authenticated: boolean; readonly status: 'error' };

export function TenantSelector() {
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' });
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadState({ status: 'loading' });
    try {
      const tenants = await listAvailableTenants(signal);
      setLoadState({ status: 'loaded', tenants });
    } catch (error) {
      if (signal?.aborted) return;
      setLoadState({
        authenticated: !(error instanceof TenantRequestError && error.status === 401),
        status: 'error',
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function selectTenant(tenant: TenantChoice) {
    if (switchingId) return;
    if (tenant.is_active) {
      window.location.assign('/dash-01');
      return;
    }
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setSwitchError('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }

    setSwitchError(null);
    setSwitchingId(tenant.id);
    try {
      await switchTenant(tenant.id, csrf);
      window.location.assign('/dash-01');
    } catch {
      setSwitchError('无法切换到该企业。成员权限可能已变更，请刷新后重试。');
      setSwitchingId(null);
    }
  }

  if (loadState.status === 'loading') return <TenantListSkeleton />;

  if (loadState.status === 'error') {
    return (
      <section className="mx-auto mt-10 max-w-xl rounded-2xl border border-line bg-white p-8 text-center shadow-panel">
        <h2 className="text-xl font-semibold text-ink-950">
          {loadState.authenticated ? '暂时无法加载企业列表' : '登录状态已失效'}
        </h2>
        <p className="mt-3 text-sm leading-6 text-ink-500">
          {loadState.authenticated ? '请检查网络连接后重试。' : '请重新登录后选择要进入的企业。'}
        </p>
        {loadState.authenticated ? (
          <button
            className="mt-6 rounded-control bg-brand-600 px-5 py-3 text-sm font-semibold text-white hover:bg-brand-700"
            onClick={() => void load()}
            type="button"
          >
            重新加载
          </button>
        ) : (
          <a
            className="mt-6 inline-flex rounded-control bg-brand-600 px-5 py-3 text-sm font-semibold text-white hover:bg-brand-700"
            href="/auth-01"
          >
            返回登录
          </a>
        )}
      </section>
    );
  }

  if (loadState.tenants.length === 0) {
    return (
      <section className="mx-auto mt-10 max-w-xl rounded-2xl border border-line bg-white p-8 text-center shadow-panel">
        <h2 className="text-xl font-semibold text-ink-950">暂无可用企业</h2>
        <p className="mt-3 text-sm leading-6 text-ink-500">
          你的成员资格可能尚未启用。请联系企业管理员完成邀请或恢复权限。
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="tenant-list-heading" className="mx-auto mt-10 max-w-3xl">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-ink-950" id="tenant-list-heading">
            可用企业
          </h2>
          <p className="mt-1 text-sm text-ink-500">仅显示当前有效的成员资格。</p>
        </div>
        <span className="text-sm text-ink-500">共 {loadState.tenants.length} 个</span>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {loadState.tenants.map((tenant) => {
          const isSwitching = switchingId === tenant.id;
          return (
            <article
              className="flex min-h-44 flex-col rounded-2xl border border-line bg-white p-5 shadow-panel"
              key={tenant.id}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-lg font-semibold text-ink-950">{tenant.name}</h3>
                  <p className="mt-1 text-sm text-ink-500">{ROLE_LABELS[tenant.role_code]}</p>
                </div>
                {tenant.is_active ? (
                  <span className="shrink-0 rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700">
                    当前企业
                  </span>
                ) : null}
              </div>
              <p className="mt-4 text-xs text-ink-500">
                上次使用：{formatLastUsedAt(tenant.last_used_at)}
              </p>
              <button
                aria-label={`${tenant.is_active ? '继续进入' : '进入'} ${tenant.name}`}
                className="mt-auto flex h-11 w-full items-center justify-center rounded-control border border-brand-600 px-4 text-sm font-semibold text-brand-700 hover:bg-brand-50 disabled:cursor-not-allowed disabled:border-line disabled:bg-surface-subtle disabled:text-ink-500"
                disabled={switchingId !== null}
                onClick={() => void selectTenant(tenant)}
                type="button"
              >
                {tenant.is_active ? '继续进入' : isSwitching ? '正在进入…' : '进入企业'}
              </button>
            </article>
          );
        })}
      </div>

      <div aria-live="assertive" className="mt-5 min-h-10">
        {switchError ? (
          <p className="rounded-control bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
            {switchError}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function TenantListSkeleton() {
  return (
    <section aria-busy="true" aria-label="正在加载企业列表" className="mx-auto mt-10 max-w-3xl">
      <div className="h-7 w-28 animate-pulse rounded bg-line" />
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {[0, 1].map((item) => (
          <div className="h-44 animate-pulse rounded-2xl border border-line bg-white" key={item} />
        ))}
      </div>
    </section>
  );
}

function formatLastUsedAt(value: string | null): string {
  if (!value) return '尚未使用';
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function readCookie(name: string): string {
  const prefix = `${encodeURIComponent(name)}=`;
  const cookie = document.cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : '';
}
