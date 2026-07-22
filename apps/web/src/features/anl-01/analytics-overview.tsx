'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import { listProjects } from '../know-02/source-upload-api';
import type { ProjectChoice } from '../know-02/source-upload.schema';
import { PlatformCodeSchema, type PlatformCode } from '../pub-01/platform-account.schema';
import { listWorkspaces } from '../set-02/workspace-settings-api';
import type { Workspace } from '../set-02/workspace-settings.schema';
import {
  AnalyticsRequestError,
  loadAnalytics,
  requestAnalyticsExport,
} from './analytics-overview-api';
import type {
  AnalyticsFilters,
  Costs,
  ExportJob,
  Overview,
  Platforms,
} from './analytics-overview.schema';

const ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'analyst']);
export function AnalyticsOverview() {
  const [filters, setFilters] = useState<AnalyticsFilters>(readFilters);
  const [workspaces, setWorkspaces] = useState<readonly Workspace[]>([]);
  const [projects, setProjects] = useState<readonly ProjectChoice[]>([]);
  const [data, setData] = useState<{
    overview: Overview;
    platforms: Platforms;
    costs: Costs;
  } | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error' | 'permission'>(
    'loading',
  );
  const [exportJob, setExportJob] = useState<ExportJob | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const load = useCallback(async (next: AnalyticsFilters, signal?: AbortSignal) => {
    setState('loading');
    try {
      const tenants = await listAvailableTenants(signal);
      const role = tenants.find((item) => item.is_active)?.role_code;
      if (!role || !ROLES.has(role)) {
        setState('permission');
        return;
      }
      const workspaceItems = (await listWorkspaces(signal)).filter(
        ({ status }) => status === 'active',
      );
      setWorkspaces(workspaceItems);
      if (!next.workspaceId) {
        setProjects([]);
        setState('empty');
        return;
      }
      setProjects(await listProjects(next.workspaceId, signal));
      const result = await loadAnalytics(next, signal);
      if (signal?.aborted) return;
      setData(result);
      setState('ready');
    } catch (error) {
      if (!signal?.aborted) setState(isAccessError(error) ? 'permission' : 'error');
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(filters, controller.signal);
    return () => controller.abort();
  }, [filters, load]);
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = parseFilters(new FormData(event.currentTarget));
    setFilters(next);
    writeFilters(next);
  }
  function drill(code: PlatformCode) {
    const next = { ...filters, platformCodes: [code] };
    setFilters(next);
    writeFilters(next);
  }
  async function exportData() {
    if (!filters.workspaceId) {
      setMessage('请先选择工作区。');
      return;
    }
    setExporting(true);
    setMessage(null);
    try {
      const job = await requestAnalyticsExport(filters);
      setExportJob(job);
      setMessage('分析导出任务已创建。');
    } catch {
      setMessage('导出任务创建失败，请稍后重试。');
    } finally {
      setExporting(false);
    }
  }
  return (
    <section className="mt-8">
      <form
        aria-label="数据总览筛选"
        className="rounded-2xl border border-line bg-white p-4 shadow-panel"
        key={JSON.stringify(filters)}
        onSubmit={apply}
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <label className={labelClass}>
            工作区
            <select
              className={controlClass}
              defaultValue={filters.workspaceId ?? ''}
              name="workspace_id"
            >
              <option value="">请选择工作区</option>
              {workspaces.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            项目
            <select
              className={controlClass}
              defaultValue={filters.projectId ?? ''}
              name="project_id"
            >
              <option value="">全部项目</option>
              {projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            平台
            <select
              className={controlClass}
              defaultValue={filters.platformCodes?.[0] ?? ''}
              name="platform_code"
            >
              <option value="">全部平台</option>
              {PLATFORMS.map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            开始日期
            <input
              className={controlClass}
              defaultValue={filters.from}
              name="from"
              required
              type="date"
            />
          </label>
          <label className={labelClass}>
            结束日期
            <input
              className={controlClass}
              defaultValue={filters.to}
              name="to"
              required
              type="date"
            />
          </label>
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <button className={primaryButton} type="submit">
            应用筛选
          </button>
          <button
            className={secondaryButton}
            disabled={!filters.workspaceId || exporting}
            onClick={() => void exportData()}
            type="button"
          >
            {exporting ? '正在导出…' : '导出 CSV'}
          </button>
        </div>
      </form>
      <div aria-live="polite" className="mt-4 min-h-6 text-sm text-ink-700">
        {message}
        {exportJob ? ` ${exportStatusLabel(exportJob.status)}` : ''}
      </div>
      {state === 'loading' ? (
        <Panel title="正在加载数据总览" text="正在按统一口径聚合指标和已结算成本。" />
      ) : state === 'permission' ? (
        <Panel title="无权查看数据总览" text="仅分析师、企业管理员和所有者可访问。" />
      ) : state === 'error' ? (
        <Panel title="无法加载数据总览" text="请检查日期、工作区、权限或服务状态。" />
      ) : state === 'empty' || !data ? (
        <Panel title="请选择工作区" text="数据总览必须在授权工作区范围内查询。" />
      ) : (
        <Dashboard data={data} onDrill={drill} />
      )}
    </section>
  );
}
function Dashboard({
  data,
  onDrill,
}: {
  readonly data: { overview: Overview; platforms: Platforms; costs: Costs };
  readonly onDrill: (code: PlatformCode) => void;
}) {
  const metric = (name: string) => data.overview.metrics.find((item) => item.name === name)?.value;
  const cost = data.costs.totals[0];
  return (
    <>
      <section className="mt-5 rounded-2xl border border-line bg-white p-5 shadow-panel">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-ink-950">核心指标</h2>
            <p className="mt-2 text-sm text-ink-500">
              口径版本：<strong>{data.overview.methodology_version}</strong>
            </p>
            <p className="mt-1 text-sm text-ink-500">
              数据更新时间：
              <strong>
                {data.overview.data_updated_at
                  ? formatDate(data.overview.data_updated_at)
                  : '暂无数据'}
              </strong>
            </p>
          </div>
        </div>
        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Kpi label="曝光" value={number(metric('exposures'))} />
          <Kpi label="阅读" value={number(metric('reads'))} />
          <Kpi label="互动" value={number(metric('engagements'))} />
          <Kpi label="转化" value={number(metric('conversions'))} />
          <Kpi
            label="可见性"
            value={`${percent(data.overview.visibility.citation_rate)} · 平均排名 ${number(data.overview.visibility.average_rank)}`}
          />
          <Kpi
            label="成本（已结算）"
            value={cost ? `${(cost.cost_cents / 100).toFixed(2)} ${cost.currency}` : '—'}
          />
        </div>
      </section>
      <section className="mt-5 rounded-2xl border border-line bg-white p-5 shadow-panel">
        <h2 className="text-xl font-semibold text-ink-950">平台下钻</h2>
        {data.platforms.platforms.length === 0 ? (
          <p className="mt-4 text-sm text-ink-500">当前范围没有平台数据。</p>
        ) : (
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-surface-subtle text-ink-500">
                <tr>
                  <th className="p-3">平台</th>
                  <th className="p-3">曝光</th>
                  <th className="p-3">阅读</th>
                  <th className="p-3">引用率</th>
                  <th className="p-3">更新时间</th>
                  <th className="p-3">动作</th>
                </tr>
              </thead>
              <tbody>
                {data.platforms.platforms.map((item) => (
                  <tr className="border-t border-line" key={item.platform_code}>
                    <td className="p-3">{platformLabel(item.platform_code)}</td>
                    <td className="p-3">
                      {number(item.metrics.find((m) => m.name === 'exposures')?.value)}
                    </td>
                    <td className="p-3">
                      {number(item.metrics.find((m) => m.name === 'reads')?.value)}
                    </td>
                    <td className="p-3">{percent(item.visibility.citation_rate)}</td>
                    <td className="p-3">
                      {item.data_updated_at ? formatDate(item.data_updated_at) : '—'}
                    </td>
                    <td className="p-3">
                      <button
                        className={smallButton}
                        onClick={() => onDrill(item.platform_code)}
                        type="button"
                      >
                        下钻
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
function Kpi({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-xl bg-surface-subtle p-4">
      <p className="text-sm text-ink-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-ink-950">{value}</p>
    </div>
  );
}
function Panel({ title, text }: { readonly title: string; readonly text: string }) {
  return (
    <section className="mt-5 rounded-2xl border border-line bg-white p-8 text-center shadow-panel">
      <h2 className="text-xl font-semibold text-ink-950">{title}</h2>
      <p className="mt-3 text-sm text-ink-500">{text}</p>
    </section>
  );
}
function parseFilters(data: FormData): AnalyticsFilters {
  const platform = PlatformCodeSchema.safeParse(data.get('platform_code'));
  const workspaceId = String(data.get('workspace_id') ?? '').trim();
  const projectId = String(data.get('project_id') ?? '').trim();
  const from = String(data.get('from') ?? '');
  const to = String(data.get('to') ?? '');
  return {
    from,
    ...(platform.success ? { platformCodes: [platform.data] } : {}),
    ...(projectId ? { projectId } : {}),
    to,
    ...(workspaceId ? { workspaceId } : {}),
  };
}
function readFilters(): AnalyticsFilters {
  const today = new Date();
  const from = new Date(today.getTime() - 29 * 86400000).toISOString().slice(0, 10);
  if (typeof window === 'undefined') return { from, to: today.toISOString().slice(0, 10) };
  const query = new URLSearchParams(window.location.search);
  const data = new FormData();
  data.set('from', query.get('from') ?? from);
  data.set('to', query.get('to') ?? today.toISOString().slice(0, 10));
  data.set('workspace_id', query.get('workspace_id') ?? '');
  data.set('project_id', query.get('project_id') ?? '');
  data.set('platform_code', query.get('platform_codes') ?? '');
  return parseFilters(data);
}
function writeFilters(filters: AnalyticsFilters) {
  const query = new URLSearchParams({ from: filters.from, to: filters.to });
  if (filters.workspaceId) query.set('workspace_id', filters.workspaceId);
  if (filters.projectId) query.set('project_id', filters.projectId);
  if (filters.platformCodes?.length) query.set('platform_codes', filters.platformCodes.join(','));
  window.history.replaceState(null, '', `/anl-01?${query}`);
}
function isAccessError(error: unknown) {
  return error instanceof AnalyticsRequestError && [401, 403, 404].includes(error.status);
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}
function number(value: number | null | undefined) {
  return value === null || value === undefined
    ? '—'
    : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
}
function percent(value: number) {
  return new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 }).format(
    value,
  );
}
function platformLabel(code: PlatformCode) {
  return PLATFORMS.find(([item]) => item === code)?.[1] ?? code;
}
function exportStatusLabel(value: ExportJob['status']) {
  return {
    queued: '导出文件正在等待生成。',
    running: '导出文件正在生成。',
    succeeded: '导出文件已生成。',
    failed: '导出失败，请稍后重试。',
    expired: '导出文件已过期，请重新导出。',
  }[value];
}
const PLATFORMS = [
  ['official_site', '官网'],
  ['baijiahao', '百家号'],
  ['toutiao', '头条号'],
  ['zhihu', '知乎'],
  ['xiaohongshu', '小红书'],
  ['wechat_mp', '微信公众号'],
  ['douyin', '抖音'],
] as const;
const labelClass = 'text-sm text-ink-700';
const controlClass =
  'mt-2 block h-11 w-full rounded-control border border-line bg-white px-3 text-sm text-ink-950 focus:border-brand-500 focus:outline-2 focus:outline-offset-2';
const primaryButton =
  'h-11 rounded-control bg-brand-600 px-5 text-sm font-semibold text-white disabled:opacity-60';
const secondaryButton =
  'h-11 rounded-control border border-line bg-white px-4 text-sm font-semibold text-ink-700 disabled:opacity-60';
const smallButton =
  'rounded-control border border-line bg-white px-3 py-2 text-xs font-semibold text-ink-700';
