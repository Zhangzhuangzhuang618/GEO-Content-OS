'use client';

import { useCallback, useEffect, useState } from 'react';
import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import {
  expireSource,
  listSources,
  reindexSource,
  SourceRequestError,
  type SourceFilters,
} from './source-api';
import type { SourceListItem, SourceStatus, SourceType, TrustLevel } from './source.schema';

const MANAGER_ROLES = new Set<TenantRole>([
  'tenant_owner',
  'tenant_admin',
  'strategy_editor',
  'content_editor',
]);

export function SourceList() {
  const initial = readFilters();
  const [filters, setFilters] = useState<SourceFilters>(initial);
  const [items, setItems] = useState<SourceListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [role, setRole] = useState<TenantRole | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'permission'>('loading');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(
    async (nextFilters: SourceFilters, append = false, signal?: AbortSignal) => {
      setState('loading');
      try {
        const tenants = await listAvailableTenants(signal);
        if (signal?.aborted) return;
        setRole(tenants.find((tenant) => tenant.is_active)?.role_code ?? null);
        if (!nextFilters.workspaceId || !nextFilters.projectId) {
          setItems([]);
          setNextCursor(null);
          setState('ready');
          return;
        }
        const page = await listSources(nextFilters, signal);
        if (signal?.aborted) return;
        setItems((current) => (append ? [...current, ...page.items] : page.items));
        setNextCursor(page.nextCursor);
        setState('ready');
      } catch (error) {
        if (signal?.aborted) return;
        setState(
          error instanceof SourceRequestError && error.status === 403 ? 'permission' : 'error',
        );
      }
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(filters, false, controller.signal);
    return () => controller.abort();
  }, [filters, load]);

  function updateFilter(name: keyof SourceFilters, value: string) {
    const next: SourceFilters = { ...filters };
    delete next.cursor;
    if (value) Object.assign(next, { [name]: value });
    else delete next[name];
    setFilters(next);
    const query = new URLSearchParams();
    if (next.search) query.set('search', next.search);
    if (next.projectId) query.set('project_id', next.projectId);
    if (next.sourceType) query.set('source_type', next.sourceType);
    if (next.status) query.set('status', next.status);
    if (next.trustLevel) query.set('trust_level', next.trustLevel);
    if (next.workspaceId) query.set('workspace_id', next.workspaceId);
    window.history.replaceState(null, '', query.size ? `/know-01?${query}` : '/know-01');
  }

  async function mutate(source: SourceListItem, operation: 'reindex' | 'expire') {
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    if (operation === 'expire' && !window.confirm(`确认将“${source.title}”标记为失效？`)) return;
    setBusyId(source.id);
    setMessage(null);
    try {
      if (operation === 'reindex') {
        await reindexSource(source, csrf);
        setItems((current) =>
          current.map((item) =>
            item.id === source.id ? { ...item, status: 'processing', parsed_at: null } : item,
          ),
        );
        setMessage('已创建重建索引任务。');
      } else {
        await expireSource(source, csrf);
        setItems((current) =>
          current.map((item) => (item.id === source.id ? { ...item, status: 'expired' } : item)),
        );
        setMessage('资料已失效，不会进入新的检索。');
      }
    } catch {
      setMessage('操作失败，资料状态可能已变化，请刷新后重试。');
    } finally {
      setBusyId(null);
    }
  }

  if (state === 'permission')
    return <StatePanel title="无权查看资料" text="当前工作区权限不允许访问知识库。" />;
  if (state === 'error') return <StatePanel title="无法加载资料" text="请检查网络后刷新页面。" />;

  const canManage = role !== null && MANAGER_ROLES.has(role);
  return (
    <section className="mt-8">
      <div className="rounded-2xl border border-line bg-white p-4 shadow-panel">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="text-sm text-ink-700">
            工作区 UUID
            <input
              className={controlClass}
              defaultValue={filters.workspaceId}
              onBlur={(event) => updateFilter('workspaceId', event.currentTarget.value.trim())}
              placeholder="必填"
            />
          </label>
          <label className="text-sm text-ink-700">
            项目 UUID
            <input
              className={controlClass}
              defaultValue={filters.projectId}
              onBlur={(event) => updateFilter('projectId', event.currentTarget.value.trim())}
              placeholder="必填"
            />
          </label>
          <label className="text-sm text-ink-700">
            搜索
            <input
              className={controlClass}
              defaultValue={filters.search}
              onBlur={(event) => updateFilter('search', event.currentTarget.value.trim())}
              placeholder="标题"
            />
          </label>
          <Filter
            label="状态"
            value={filters.status}
            onChange={(value) => updateFilter('status', value)}
            options={[
              ['processing', '解析中'],
              ['active', '有效'],
              ['expired', '已失效'],
              ['failed', '失败'],
            ]}
          />
          <Filter
            label="类型"
            value={filters.sourceType}
            onChange={(value) => updateFilter('sourceType', value)}
            options={[
              ['pdf', 'PDF'],
              ['docx', 'DOCX'],
              ['txt', 'TXT'],
              ['url', 'URL'],
              ['image', '图片'],
            ]}
          />
          <Filter
            label="可信级别"
            value={filters.trustLevel}
            onChange={(value) => updateFilter('trustLevel', value)}
            options={[
              ['verified', '已验证'],
              ['normal', '普通'],
              ['untrusted', '不可信'],
            ]}
          />
        </div>
        {canManage ? (
          <div className="mt-4 flex flex-wrap gap-3">
            <a className={primaryLink} href="/know-02?mode=file">
              上传资料
            </a>
            <a className={secondaryLink} href="/know-02?mode=url">
              登记 URL
            </a>
          </div>
        ) : null}
      </div>

      {state === 'loading' && items.length === 0 ? (
        <ListSkeleton />
      ) : !filters.workspaceId || !filters.projectId ? (
        <StatePanel title="请选择资料范围" text="填写工作区和项目 UUID 后加载资料。" />
      ) : items.length === 0 ? (
        <StatePanel title="暂无资料" text="当前筛选条件下没有可见资料。" />
      ) : (
        <div className="mt-5 overflow-hidden rounded-2xl border border-line bg-white shadow-panel">
          <ul className="divide-y divide-line" aria-label="资料列表">
            {items.map((source) => (
              <SourceRow
                busy={busyId === source.id}
                canManage={canManage}
                key={source.id}
                onMutate={mutate}
                source={source}
              />
            ))}
          </ul>
        </div>
      )}
      <div aria-live="polite" className="mt-4 min-h-10">
        {message ? (
          <p className="rounded-control bg-brand-50 px-3 py-2 text-sm text-brand-700" role="status">
            {message}
          </p>
        ) : null}
      </div>
      {nextCursor ? (
        <button
          className="mt-2 h-11 rounded-control border border-brand-600 px-5 text-sm font-semibold text-brand-700"
          disabled={state === 'loading'}
          onClick={() => void load({ ...filters, cursor: nextCursor }, true)}
          type="button"
        >
          加载更多
        </button>
      ) : null}
    </section>
  );
}

function SourceRow({
  busy,
  canManage,
  onMutate,
  source,
}: {
  busy: boolean;
  canManage: boolean;
  onMutate: (source: SourceListItem, operation: 'reindex' | 'expire') => Promise<void>;
  source: SourceListItem;
}) {
  const expired = source.status === 'expired';
  return (
    <li className={`p-5 ${expired ? 'bg-surface-subtle' : ''}`}>
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {source.project_id ? (
              <a
                className="font-semibold text-ink-950 hover:text-brand-700"
                href={`/know-03?id=${source.id}&workspace_id=${source.workspace_id}&project_id=${source.project_id}`}
              >
                {source.title}
              </a>
            ) : (
              <span className="font-semibold text-ink-950">{source.title}</span>
            )}
            <StatusBadge status={source.status} />
            <span className="text-xs text-ink-500">{source.source_type.toUpperCase()}</span>
          </div>
          <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-xs text-ink-500">
            <div>
              <dt className="inline">可信：</dt>
              <dd className="inline">{trustLabel(source.trust_level)}</dd>
            </div>
            <div>
              <dt className="inline">有效期：</dt>
              <dd className="inline">{source.effective_to ?? '长期'}</dd>
            </div>
            <div>
              <dt className="inline">最近解析：</dt>
              <dd className="inline">{formatDateTime(source.parsed_at)}</dd>
            </div>
          </dl>
          {expired ? (
            <p className="mt-2 text-xs font-medium text-red-700">已失效资料不会进入新的检索。</p>
          ) : null}
        </div>
        {canManage ? (
          <div className="flex shrink-0 flex-wrap gap-2">
            {!expired ? (
              <button
                className={secondaryButton}
                disabled={busy}
                onClick={() => void onMutate(source, 'reindex')}
                type="button"
              >
                重建索引
              </button>
            ) : null}
            {!expired ? (
              <button
                className={dangerButton}
                disabled={busy}
                onClick={() => void onMutate(source, 'expire')}
                type="button"
              >
                标记失效
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function Filter({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: readonly (readonly [string, string])[];
  value?: string | undefined;
}) {
  return (
    <label className="text-sm text-ink-700">
      {label}
      <select
        className={controlClass}
        onChange={(event) => onChange(event.currentTarget.value)}
        value={value ?? ''}
      >
        <option value="">全部</option>
        {options.map(([code, name]) => (
          <option key={code} value={code}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}
function StatusBadge({ status }: { status: SourceStatus }) {
  const labels = {
    processing: '解析中',
    active: '有效',
    expired: '已失效',
    failed: '失败',
  } as const;
  return (
    <span className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700">
      {labels[status]}
    </span>
  );
}
function StatePanel({ text, title }: { text: string; title: string }) {
  return (
    <section className="mt-5 rounded-2xl border border-line bg-white p-8 text-center shadow-panel">
      <h2 className="text-xl font-semibold text-ink-950">{title}</h2>
      <p className="mt-3 text-sm text-ink-500">{text}</p>
    </section>
  );
}
function ListSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="正在加载资料"
      className="mt-5 h-72 animate-pulse rounded-2xl border border-line bg-white"
    />
  );
}
function trustLabel(value: TrustLevel) {
  return { verified: '已验证', normal: '普通', untrusted: '不可信' }[value];
}
function formatDateTime(value: string | null) {
  return value
    ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      )
    : '尚未完成';
}
function readFilters(): SourceFilters {
  if (typeof window === 'undefined') return {};
  const query = new URLSearchParams(window.location.search);
  return {
    ...(query.get('project_id') ? { projectId: query.get('project_id')! } : {}),
    ...(query.get('search') ? { search: query.get('search')! } : {}),
    ...(query.get('source_type') ? { sourceType: query.get('source_type') as SourceType } : {}),
    ...(query.get('status') ? { status: query.get('status') as SourceStatus } : {}),
    ...(query.get('trust_level') ? { trustLevel: query.get('trust_level') as TrustLevel } : {}),
    ...(query.get('workspace_id') ? { workspaceId: query.get('workspace_id')! } : {}),
  };
}
function readCookie(name: string) {
  const prefix = `${encodeURIComponent(name)}=`;
  const cookie = document.cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : '';
}
const controlClass =
  'mt-2 h-11 w-full rounded-control border border-line bg-white px-3 text-sm text-ink-950 focus:border-brand-500 focus:outline-none';
const primaryLink =
  'inline-flex h-10 items-center rounded-control bg-brand-600 px-4 text-sm font-semibold text-white';
const secondaryLink =
  'inline-flex h-10 items-center rounded-control border border-brand-600 px-4 text-sm font-semibold text-brand-700';
const secondaryButton =
  'h-10 rounded-control border border-brand-600 px-3 text-sm font-semibold text-brand-700 disabled:opacity-60';
const dangerButton =
  'h-10 rounded-control border border-red-300 px-3 text-sm font-semibold text-red-700 disabled:opacity-60';
