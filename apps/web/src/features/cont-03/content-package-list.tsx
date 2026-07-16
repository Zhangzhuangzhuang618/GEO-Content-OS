'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import {
  ContentPackageListRequestError,
  copyContentPackage,
  listContentPackages,
} from './content-package-list-api';
import {
  ContentPackageStatusSchema,
  PlatformCodeSchema,
  type ContentPackageStatus,
  type PackageFilters,
  type PackageListItem,
  type PlatformCode,
} from './content-package-list.schema';

const COPY_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'content_editor']);
const COST_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'analyst']);

export function ContentPackageList() {
  const [filters, setFilters] = useState<PackageFilters>(readFilters);
  const [items, setItems] = useState<PackageListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [canCopy, setCanCopy] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'permission'>('loading');
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ readonly id?: string; readonly text: string } | null>(
    null,
  );

  const load = useCallback(async (next: PackageFilters, signal?: AbortSignal) => {
    setState('loading');
    try {
      const tenants = await listAvailableTenants(signal);
      const role = tenants.find((tenant) => tenant.is_active)?.role_code;
      if (!role) {
        setState('permission');
        return;
      }
      const page = await listContentPackages(next, COST_ROLES.has(role), signal);
      if (signal?.aborted) return;
      setCanCopy(COPY_ROLES.has(role));
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setState('ready');
    } catch (error) {
      if (signal?.aborted) return;
      setState(isAccessError(error) ? 'permission' : 'error');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(filters, controller.signal);
    return () => controller.abort();
  }, [filters, load]);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const platform = PlatformCodeSchema.safeParse(data.get('platform_code'));
    const status = ContentPackageStatusSchema.safeParse(data.get('status'));
    const createdBy = String(data.get('created_by') ?? '').trim();
    const projectId = String(data.get('project_id') ?? '').trim();
    const workspaceId = String(data.get('workspace_id') ?? '').trim();
    const next: PackageFilters = {
      ...(createdBy ? { createdBy } : {}),
      ...(platform.success ? { platformCode: platform.data } : {}),
      ...(projectId ? { projectId } : {}),
      ...(status.success ? { status: status.data } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    };
    setFilters(next);
    writeFilters(next);
  }

  function changePage(cursor?: string) {
    const next = { ...filters, ...(cursor ? { cursor } : {}) };
    if (!cursor) delete next.cursor;
    setFilters(next);
    writeFilters(next);
  }

  async function copy(item: PackageListItem) {
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage({ text: '安全令牌尚未就绪，请刷新页面后重试。' });
      return;
    }
    setCopyingId(item.package.id);
    setMessage(null);
    try {
      const created = await copyContentPackage(item.package, csrf);
      setMessage({ id: created.id, text: '内容包副本已创建。' });
    } catch {
      setMessage({ text: '复制失败，请确认当前角色仍有内容生产权限。' });
    } finally {
      setCopyingId(null);
    }
  }

  if (state === 'permission')
    return <StatePanel title="无权查看内容包" text="当前租户或工作区未授权访问。" />;
  if (state === 'error')
    return <StatePanel title="无法加载内容包" text="请检查筛选条件或网络后重试。" />;

  return (
    <section className="mt-8">
      <form
        aria-label="内容包筛选"
        className="rounded-2xl border border-line bg-white p-4 shadow-panel"
        key={filterFormKey(filters)}
        onSubmit={applyFilters}
      >
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <TextField defaultValue={filters.workspaceId} label="工作区 UUID" name="workspace_id" />
          <TextField defaultValue={filters.projectId} label="项目 UUID" name="project_id" />
          <TextField defaultValue={filters.createdBy} label="负责人 UUID" name="created_by" />
          <SelectField
            label="包状态"
            name="status"
            options={STATUS_OPTIONS}
            value={filters.status}
          />
          <SelectField
            label="平台"
            name="platform_code"
            options={PLATFORM_OPTIONS}
            value={filters.platformCode}
          />
          <div className="flex items-end gap-3">
            <button className={primaryButton} type="submit">
              应用筛选
            </button>
            <button
              className={secondaryButton}
              onClick={() => {
                setFilters({});
                writeFilters({});
              }}
              type="button"
            >
              清空
            </button>
          </div>
        </div>
      </form>

      <p className="mt-5 rounded-control bg-brand-50 p-3 text-sm text-brand-700">
        包状态由各平台变体投影得出，仅作列表摘要；审核、排期和发布动作以详情中的变体状态为准。
      </p>
      {message ? (
        <p aria-live="polite" className="mt-4 text-sm text-ink-700">
          {message.text}{' '}
          {message.id ? (
            <Link className="text-brand-700" href={`/cont-04?id=${message.id}`}>
              查看副本
            </Link>
          ) : null}
        </p>
      ) : null}

      {state === 'loading' ? (
        <StatePanel title="正在加载内容包" text="正在读取当前分页、变体进度和已结算成本。" />
      ) : items.length === 0 ? (
        <StatePanel title="暂无内容包" text="当前筛选和分页下没有内容包。" />
      ) : (
        <div className="mt-5 overflow-x-auto rounded-2xl border border-line bg-white shadow-panel">
          <table className="w-full min-w-[1100px] text-left text-sm">
            <thead className="bg-surface-subtle text-ink-500">
              <tr>
                <th className="p-4">内容包</th>
                <th className="p-4">包状态（摘要）</th>
                <th className="p-4">质量</th>
                <th className="p-4">平台进度</th>
                <th className="p-4">负责人</th>
                <th className="p-4">成本（已结算）</th>
                <th className="p-4">更新时间</th>
                <th className="p-4">动作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <PackageRow
                  canCopy={canCopy}
                  copying={copyingId === item.package.id}
                  item={item}
                  key={item.package.id}
                  onCopy={copy}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <nav aria-label="内容包分页" className="mt-5 flex flex-wrap gap-3">
        {filters.cursor ? (
          <button className={secondaryButton} onClick={() => changePage()} type="button">
            返回第一页
          </button>
        ) : null}
        {nextCursor ? (
          <button className={primaryButton} onClick={() => changePage(nextCursor)} type="button">
            下一页
          </button>
        ) : null}
      </nav>
    </section>
  );
}

function PackageRow({
  canCopy,
  copying,
  item,
  onCopy,
}: {
  readonly canCopy: boolean;
  readonly copying: boolean;
  readonly item: PackageListItem;
  readonly onCopy: (item: PackageListItem) => Promise<void>;
}) {
  const scored = item.variants.flatMap((variant) =>
    variant.quality_score === null ? [] : [variant.quality_score],
  );
  const produced = item.variants.filter((variant) => !UNPRODUCED.has(variant.status)).length;
  return (
    <tr className="border-t border-line">
      <td className="p-4">
        <Link className="font-medium text-brand-700" href={`/cont-04?id=${item.package.id}`}>
          {shortId(item.package.id)}
        </Link>
        <p className="mt-1 font-mono text-xs text-ink-500">
          项目 {shortId(item.package.project_id)}
        </p>
      </td>
      <td className="p-4">{statusLabel(item.package.status)}</td>
      <td className="p-4">{scored.length ? `${average(scored)} 分` : '待检查'}</td>
      <td className="p-4">
        <span className="font-medium">
          已产出 {produced}/{item.variants.length}
        </span>
        <p className="mt-1 text-xs text-ink-500">
          {item.variants.map((variant) => platformLabel(variant.platform_code)).join('、')}
        </p>
      </td>
      <td className="p-4 font-mono text-xs">{item.package.created_by}</td>
      <td className="p-4">{formatCosts(item.costs)}</td>
      <td className="p-4">{new Date(item.package.updated_at).toLocaleString('zh-CN')}</td>
      <td className="p-4">
        <div className="flex gap-3">
          <Link className="text-brand-700" href={`/cont-04?id=${item.package.id}`}>
            进入详情
          </Link>
          {canCopy ? (
            <button
              className="text-brand-700 disabled:text-ink-500"
              disabled={copying}
              onClick={() => void onCopy(item)}
              type="button"
            >
              {copying ? '复制中' : '复制'}
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

const UNPRODUCED = new Set(['draft', 'generating', 'generation_failed', 'cancelled']);
const PLATFORM_OPTIONS = [
  ['official_site', '官网'],
  ['baijiahao', '百家号'],
  ['toutiao', '头条号'],
  ['zhihu', '知乎'],
  ['xiaohongshu', '小红书'],
  ['wechat_mp', '微信公众号'],
  ['douyin', '抖音'],
] as const satisfies readonly (readonly [PlatformCode, string])[];
const STATUS_OPTIONS = [
  ['draft', '草稿'],
  ['generating', '生成中'],
  ['generated', '已生成'],
  ['all_failed', '全部失败'],
  ['editing', '编辑中'],
  ['in_review', '审核中'],
  ['rejected', '已退回'],
  ['approved', '已通过'],
  ['scheduled', '已排期'],
  ['publishing', '发布中'],
  ['publish_failed', '发布失败'],
  ['published', '已发布'],
  ['cancelled', '已取消'],
  ['archived', '已归档'],
] as const satisfies readonly (readonly [ContentPackageStatus, string])[];

function average(values: readonly number[]) {
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}
function formatCosts(costs: PackageListItem['costs']) {
  if (costs === null) return '无成本权限';
  if (costs.length === 0) return '暂无';
  return costs.map((cost) => `${cost.currency} ${(cost.costCents / 100).toFixed(2)}`).join(' / ');
}
function platformLabel(code: PlatformCode) {
  return PLATFORM_OPTIONS.find(([value]) => value === code)?.[1] ?? code;
}
function statusLabel(code: ContentPackageStatus) {
  return STATUS_OPTIONS.find(([value]) => value === code)?.[1] ?? code;
}
function shortId(id: string) {
  return id.slice(0, 8);
}
function filterFormKey(filters: PackageFilters) {
  return [
    filters.workspaceId ?? '',
    filters.projectId ?? '',
    filters.createdBy ?? '',
    filters.status ?? '',
    filters.platformCode ?? '',
  ].join('|');
}
function isAccessError(error: unknown) {
  if (error instanceof ContentPackageListRequestError)
    return [401, 403, 404].includes(error.status);
  if (!error || typeof error !== 'object') return false;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === 'number' && [401, 403, 404].includes(status);
}
function readFilters(): PackageFilters {
  if (typeof window === 'undefined') return {};
  const query = new URLSearchParams(window.location.search);
  const platform = PlatformCodeSchema.safeParse(query.get('platform_code'));
  const status = ContentPackageStatusSchema.safeParse(query.get('status'));
  const createdBy = query.get('created_by');
  const cursor = query.get('cursor');
  const projectId = query.get('project_id');
  const workspaceId = query.get('workspace_id');
  return {
    ...(createdBy ? { createdBy } : {}),
    ...(cursor ? { cursor } : {}),
    ...(platform.success ? { platformCode: platform.data } : {}),
    ...(projectId ? { projectId } : {}),
    ...(status.success ? { status: status.data } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  };
}
function writeFilters(filters: PackageFilters) {
  const query = new URLSearchParams();
  if (filters.workspaceId) query.set('workspace_id', filters.workspaceId);
  if (filters.projectId) query.set('project_id', filters.projectId);
  if (filters.createdBy) query.set('created_by', filters.createdBy);
  if (filters.status) query.set('status', filters.status);
  if (filters.platformCode) query.set('platform_code', filters.platformCode);
  if (filters.cursor) query.set('cursor', filters.cursor);
  window.history.replaceState(null, '', query.size ? `/cont-03?${query}` : '/cont-03');
}
function readCookie(name: string) {
  const entry = document.cookie.split('; ').find((value) => value.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
}
function TextField({
  defaultValue,
  label,
  name,
}: {
  readonly defaultValue?: string | undefined;
  readonly label: string;
  readonly name: string;
}) {
  return (
    <label className="text-sm text-ink-700">
      {label}
      <input className={controlClass} defaultValue={defaultValue ?? ''} name={name} type="text" />
    </label>
  );
}
function SelectField({
  label,
  name,
  options,
  value,
}: {
  readonly label: string;
  readonly name: string;
  readonly options: readonly (readonly [string, string])[];
  readonly value?: string | undefined;
}) {
  return (
    <label className="text-sm text-ink-700">
      {label}
      <select className={controlClass} defaultValue={value ?? ''} name={name}>
        <option value="">全部</option>
        {options.map(([code, text]) => (
          <option key={code} value={code}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}
function StatePanel({ title, text }: { readonly title: string; readonly text: string }) {
  return (
    <div className="mt-5 rounded-2xl border border-line bg-white p-8 text-center shadow-panel">
      <h2 className="font-semibold text-ink-950">{title}</h2>
      <p className="mt-2 text-sm text-ink-500">{text}</p>
    </div>
  );
}
const controlClass =
  'mt-2 h-11 w-full rounded-control border border-line bg-white px-3 text-sm text-ink-950 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-100';
const primaryButton =
  'inline-flex h-11 items-center justify-center rounded-control bg-brand-600 px-4 text-sm font-semibold text-white disabled:opacity-50';
const secondaryButton =
  'h-11 rounded-control border border-line px-4 text-sm font-semibold text-ink-700';
