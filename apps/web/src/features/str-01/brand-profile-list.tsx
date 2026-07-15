'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import {
  BrandProfileListRequestError,
  listBrandProfiles,
  publishProfile,
  retireProfile,
} from './brand-profile-list-api';
import type { BrandProfileListItem, BrandProfileStatus } from './brand-profile-list.schema';

const MANAGER_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'strategy_editor']);
type State =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'permission' }
  | { canManage: boolean; items: BrandProfileListItem[]; status: 'ready' };

export function BrandProfileList() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [selected, setSelected] = useState<string[]>([]);
  const [showComparison, setShowComparison] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<BrandProfileStatus | ''>('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const value = params.get('status');
    const initial = value === 'draft' || value === 'published' || value === 'retired' ? value : '';
    setFilter(initial);
    const controller = new AbortController();
    void load(initial, controller.signal);
    return () => controller.abort();
  }, []);

  async function load(status: BrandProfileStatus | '', signal?: AbortSignal) {
    try {
      const [tenants, items] = await Promise.all([
        listAvailableTenants(signal),
        listBrandProfiles(status || undefined, signal),
      ]);
      const role = tenants.find((tenant) => tenant.is_active)?.role_code;
      if (!role) {
        setState({ status: 'permission' });
        return;
      }
      setState({ canManage: MANAGER_ROLES.has(role), items, status: 'ready' });
      setSelected([]);
      setShowComparison(false);
    } catch (error) {
      if (signal?.aborted) return;
      setState({
        status:
          error instanceof BrandProfileListRequestError && error.status === 403
            ? 'permission'
            : 'error',
      });
    }
  }

  function changeFilter(value: BrandProfileStatus | '') {
    setFilter(value);
    setShowComparison(false);
    const url = value ? `/str-01?status=${value}` : '/str-01';
    window.history.replaceState(null, '', url);
    setState({ status: 'loading' });
    void load(value);
  }

  async function mutate(item: BrandProfileListItem, action: 'publish' | 'retire') {
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    let reason = '';
    if (action === 'retire') {
      reason = window.prompt('请输入退役原因')?.trim() ?? '';
      if (!reason) return;
    }
    setBusyId(item.id);
    setMessage(null);
    try {
      await (action === 'publish' ? publishProfile(item, csrf) : retireProfile(item, reason, csrf));
      setMessage(action === 'publish' ? '策略已发布。' : '策略已退役。');
      await load(filter);
    } catch {
      setMessage('操作失败，版本可能已变化，请刷新后重试。');
    } finally {
      setBusyId(null);
    }
  }

  if (state.status === 'loading') return <Panel title="正在加载品牌策略" />;
  if (state.status === 'permission') return <Panel title="无权查看品牌策略" />;
  if (state.status === 'error') return <Panel title="无法加载品牌策略" />;
  const compared = selected
    .map((id) => state.items.find((item) => item.id === id))
    .filter((item): item is BrandProfileListItem => Boolean(item));

  return (
    <div>
      <div className="flex flex-col gap-3 rounded-2xl border border-line bg-white p-4 shadow-panel sm:flex-row sm:items-center sm:justify-between">
        <label className="text-sm font-medium text-ink-700">
          状态筛选
          <select
            aria-label="状态筛选"
            className="ml-3 h-10 rounded-control border border-line bg-white px-3"
            onChange={(event) => changeFilter(event.target.value as BrandProfileStatus | '')}
            value={filter}
          >
            <option value="">全部</option>
            <option value="draft">草稿</option>
            <option value="published">已发布</option>
            <option value="retired">已退役</option>
          </select>
        </label>
        <div className="flex gap-3">
          <button
            className="h-10 rounded-control border border-line px-4 text-sm font-semibold disabled:opacity-50"
            disabled={selected.length !== 2}
            onClick={() => setShowComparison(true)}
            type="button"
          >
            比较所选版本
          </button>
          {state.canManage ? (
            <Link
              className="flex h-10 items-center rounded-control bg-brand-600 px-4 text-sm font-semibold text-white"
              href="/str-02"
            >
              创建策略
            </Link>
          ) : null}
        </div>
      </div>
      {state.items.length === 0 ? (
        <Panel title="暂无品牌策略" />
      ) : (
        <div className="mt-5 overflow-x-auto rounded-2xl border border-line bg-white shadow-panel">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="bg-surface-subtle text-ink-500">
              <tr>
                <th className="p-4">比较</th>
                <th className="p-4">名称</th>
                <th className="p-4">版本</th>
                <th className="p-4">状态</th>
                <th className="p-4">发布时间</th>
                <th className="p-4">创建人</th>
                <th className="p-4">动作</th>
              </tr>
            </thead>
            <tbody>
              {state.items.map((item) => (
                <tr className="border-t border-line" key={item.id}>
                  <td className="p-4">
                    <input
                      aria-label={`选择版本 v${item.version}`}
                      checked={selected.includes(item.id)}
                      disabled={!selected.includes(item.id) && selected.length >= 2}
                      onChange={(event) => {
                        setShowComparison(false);
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, item.id]
                            : current.filter((id) => id !== item.id),
                        );
                      }}
                      type="checkbox"
                    />
                  </td>
                  <td className="p-4 font-medium text-ink-950">{item.profile.positioning}</td>
                  <td className="p-4">v{item.version}</td>
                  <td className="p-4">{statusLabel(item.status)}</td>
                  <td className="p-4">
                    {item.published_at ? new Date(item.published_at).toLocaleString('zh-CN') : '—'}
                  </td>
                  <td className="p-4 font-mono text-xs">{item.created_by}</td>
                  <td className="p-4">
                    <div className="flex gap-2">
                      <Link className="text-brand-700" href={`/str-02?id=${item.id}`}>
                        查看
                      </Link>
                      {state.canManage && item.status === 'draft' ? (
                        <button
                          className="text-brand-700 disabled:opacity-50"
                          disabled={busyId === item.id}
                          onClick={() => void mutate(item, 'publish')}
                          type="button"
                        >
                          发布
                        </button>
                      ) : null}
                      {state.canManage && item.status === 'published' ? (
                        <button
                          className="text-red-700 disabled:opacity-50"
                          disabled={busyId === item.id}
                          onClick={() => void mutate(item, 'retire')}
                          type="button"
                        >
                          退役
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div aria-live="polite" className="mt-4 min-h-6">
        {message ? <p role="status">{message}</p> : null}
      </div>
      {showComparison && compared.length === 2 ? (
        <section
          aria-label="版本比较"
          className="mt-5 grid gap-4 rounded-2xl border border-line bg-white p-5 sm:grid-cols-2"
        >
          {compared.map((item) => (
            <div key={item.id}>
              <h2 className="font-semibold">
                v{item.version} · {statusLabel(item.status)}
              </h2>
              <p className="mt-2 text-sm text-ink-700">{item.profile.positioning}</p>
              <p className="mt-2 text-sm text-ink-500">语气：{item.profile.tone}</p>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function Panel({ title }: { readonly title: string }) {
  return (
    <div className="mt-5 rounded-2xl border border-line bg-white p-8 text-center text-ink-500">
      <p>{title}</p>
    </div>
  );
}
function statusLabel(status: BrandProfileStatus) {
  return status === 'draft' ? '草稿' : status === 'published' ? '已发布' : '已退役';
}
function readCookie(name: string) {
  const prefix = `${encodeURIComponent(name)}=`;
  const cookie = document.cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : '';
}
