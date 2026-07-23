'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import { BriefListRequestError, listBriefs } from './brief-list-api';
import {
  BriefObjectiveSchema,
  PlatformCodeSchema,
  type Brief,
  type BriefFilters,
  type BriefObjective,
  type PlatformCode,
} from './brief-list.schema';

const MANAGER_ROLES = new Set<TenantRole>([
  'tenant_owner',
  'tenant_admin',
  'strategy_editor',
  'content_editor',
]);
const PLATFORM_OPTIONS = [
  ['official_site', '官网'],
  ['baijiahao', '百家号'],
  ['toutiao', '头条号'],
  ['zhihu', '知乎'],
  ['xiaohongshu', '小红书'],
  ['wechat_mp', '微信公众号'],
  ['douyin', '抖音'],
] as const satisfies readonly (readonly [PlatformCode, string])[];

export function BriefList() {
  const [filters, setFilters] = useState<BriefFilters>(readFilters);
  const [items, setItems] = useState<Brief[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'permission'>('loading');

  const load = useCallback(async (next: BriefFilters, signal?: AbortSignal) => {
    setState('loading');
    try {
      const [tenants, page] = await Promise.all([
        listAvailableTenants(signal),
        listBriefs(next, signal),
      ]);
      if (signal?.aborted) return;
      const role = tenants.find((tenant) => tenant.is_active)?.role_code;
      if (!role) {
        setState('permission');
        return;
      }
      setCanManage(MANAGER_ROLES.has(role));
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
    const objective = BriefObjectiveSchema.safeParse(data.get('objective'));
    const platform = PlatformCodeSchema.safeParse(data.get('platform_code'));
    const projectId = String(data.get('project_id') ?? '').trim();
    const createdBy = String(data.get('created_by') ?? '').trim();
    const search = String(data.get('search') ?? '').trim();
    const next: BriefFilters = {
      ...(createdBy ? { createdBy } : {}),
      ...(objective.success ? { objective: objective.data } : {}),
      ...(platform.success ? { platformCode: platform.data } : {}),
      ...(projectId ? { projectId } : {}),
      ...(search ? { search } : {}),
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

  if (state === 'permission')
    return <StatePanel title="无权查看内容需求" text="当前企业或工作区未授权访问。" />;
  if (state === 'error')
    return <StatePanel title="无法加载内容需求" text="请检查筛选条件或网络后重试。" />;

  return (
    <section className="mt-8">
      <form
        aria-label="内容需求筛选"
        className="rounded-2xl border border-line bg-white p-4 shadow-panel"
        key={filterFormKey(filters)}
        onSubmit={applyFilters}
      >
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <TextField defaultValue={filters.search} label="搜索标题" name="search" />
          <SelectField
            label="平台"
            name="platform_code"
            value={filters.platformCode}
            options={PLATFORM_OPTIONS}
          />
          <SelectField
            label="目标"
            name="objective"
            value={filters.objective}
            options={OBJECTIVE_OPTIONS}
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

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-500">按标题、平台或创作目标查找内容需求。</p>
        {canManage ? (
          <Link className={primaryButton} href="/cont-02">
            创建内容需求
          </Link>
        ) : null}
      </div>

      {state === 'loading' ? (
        <StatePanel title="正在加载内容需求" text="正在读取内容列表。" />
      ) : items.length === 0 ? (
        <StatePanel title="暂无内容需求" text="当前筛选条件下没有内容需求。" />
      ) : (
        <div className="mt-5 overflow-x-auto rounded-2xl border border-line bg-white shadow-panel">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="bg-surface-subtle text-ink-500">
              <tr>
                <th className="p-4">标题</th>
                <th className="p-4">平台</th>
                <th className="p-4">目标</th>
                <th className="p-4">更新时间</th>
                <th className="p-4">动作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((brief) => (
                <BriefRow brief={brief} canManage={canManage} key={brief.id} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <nav aria-label="内容需求分页" className="mt-5 flex flex-wrap gap-3">
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

function BriefRow({ brief, canManage }: { readonly brief: Brief; readonly canManage: boolean }) {
  return (
    <tr className="border-t border-line">
      <td className="p-4">
        <Link className="font-medium text-brand-700" href={`/cont-02?id=${brief.id}`}>
          {brief.title}
        </Link>
      </td>
      <td className="p-4">{brief.platform_codes.map(platformLabel).join('、')}</td>
      <td className="p-4">{objectiveLabel(brief.objective)}</td>
      <td className="p-4">{new Date(brief.updated_at).toLocaleString('zh-CN')}</td>
      <td className="p-4">
        {canManage ? (
          <Link className="text-brand-700" href={`/cont-02?copy_from=${brief.id}`}>
            复制
          </Link>
        ) : (
          <span className="text-ink-500">查看</span>
        )}
      </td>
    </tr>
  );
}

const OBJECTIVE_OPTIONS = [
  ['awareness', '品牌认知'],
  ['conversion', '转化'],
  ['trust', '信任'],
  ['education', '教育'],
] as const satisfies readonly (readonly [BriefObjective, string])[];
function platformLabel(code: PlatformCode) {
  return PLATFORM_OPTIONS.find(([value]) => value === code)?.[1] ?? code;
}
function objectiveLabel(code: BriefObjective) {
  return OBJECTIVE_OPTIONS.find(([value]) => value === code)?.[1] ?? code;
}
function filterFormKey(filters: BriefFilters) {
  return [
    filters.search ?? '',
    filters.projectId ?? '',
    filters.platformCode ?? '',
    filters.objective ?? '',
    filters.createdBy ?? '',
  ].join('|');
}
function isAccessError(error: unknown) {
  if (error instanceof BriefListRequestError) return [401, 403, 404].includes(error.status);
  if (!error || typeof error !== 'object') return false;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === 'number' && [401, 403, 404].includes(status);
}
function readFilters(): BriefFilters {
  if (typeof window === 'undefined') return {};
  const query = new URLSearchParams(window.location.search);
  const objective = BriefObjectiveSchema.safeParse(query.get('objective'));
  const platform = PlatformCodeSchema.safeParse(query.get('platform_code'));
  const createdBy = query.get('created_by');
  const cursor = query.get('cursor');
  const projectId = query.get('project_id');
  const search = query.get('search');
  return {
    ...(createdBy ? { createdBy } : {}),
    ...(cursor ? { cursor } : {}),
    ...(objective.success ? { objective: objective.data } : {}),
    ...(platform.success ? { platformCode: platform.data } : {}),
    ...(projectId ? { projectId } : {}),
    ...(search ? { search } : {}),
  };
}
function writeFilters(filters: BriefFilters) {
  const query = new URLSearchParams();
  if (filters.search) query.set('search', filters.search);
  if (filters.projectId) query.set('project_id', filters.projectId);
  if (filters.platformCode) query.set('platform_code', filters.platformCode);
  if (filters.objective) query.set('objective', filters.objective);
  if (filters.createdBy) query.set('created_by', filters.createdBy);
  if (filters.cursor) query.set('cursor', filters.cursor);
  window.history.replaceState(null, '', query.size ? `/cont-01?${query}` : '/cont-01');
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
