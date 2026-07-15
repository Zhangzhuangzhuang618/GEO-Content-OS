'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import { listWorkspaces } from '../set-02/workspace-settings-api';
import type { Workspace } from '../set-02/workspace-settings.schema';
import { DashboardRequestError, listProjects, loadDashboardData } from './dashboard-api';
import type {
  DashboardContentPackage,
  DashboardData,
  DashboardFilters,
  DashboardProject,
} from './dashboard.schema';

const COST_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'analyst']);
const REVIEW_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'reviewer']);
const PUBLISH_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'publisher']);
const FAILURE_STATUSES = new Set(['all_failed', 'publish_failed']);
const PUBLISH_TODO_STATUSES = new Set(['scheduled', 'publishing', 'publish_failed']);

interface ReadyState {
  readonly data: DashboardData;
  readonly filters: DashboardFilters;
  readonly projects: readonly DashboardProject[];
  readonly role: TenantRole;
  readonly status: 'ready';
  readonly workspaces: readonly Workspace[];
}

type State = { readonly status: 'empty' | 'error' | 'loading' | 'permission' } | ReadyState;

export function Dashboard() {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    void bootstrap(controller.signal);
    return () => controller.abort();
  }, []);

  async function bootstrap(signal: AbortSignal) {
    try {
      const [tenants, workspaces] = await Promise.all([
        listAvailableTenants(signal),
        listWorkspaces(signal),
      ]);
      const role = tenants.find((tenant) => tenant.is_active)?.role_code;
      if (!role) return setState({ status: 'permission' });
      const activeWorkspaces = workspaces.filter((workspace) => workspace.status === 'active');
      if (activeWorkspaces.length === 0) return setState({ status: 'empty' });
      const requested = filtersFromLocation();
      const workspaceId = activeWorkspaces.some((item) => item.id === requested.workspaceId)
        ? requested.workspaceId
        : activeWorkspaces[0]!.id;
      const projects = await listProjects(workspaceId, signal);
      const projectId = projects.some((item) => item.id === requested.projectId)
        ? requested.projectId
        : '';
      const filters = { ...requested, projectId, workspaceId };
      writeFilters(filters);
      const data = await loadDashboardData(filters, COST_ROLES.has(role), signal);
      setState({ data, filters, projects, role, status: 'ready', workspaces: activeWorkspaces });
    } catch (error) {
      if (signal.aborted) return;
      setState({
        status: isAccessError(error) ? 'permission' : 'error',
      });
    }
  }

  async function updateFilters(next: DashboardFilters) {
    if (state.status !== 'ready') return;
    setState({ status: 'loading' });
    writeFilters(next);
    try {
      const projects =
        next.workspaceId === state.filters.workspaceId
          ? state.projects
          : await listProjects(next.workspaceId);
      const filters = {
        ...next,
        projectId: projects.some((project) => project.id === next.projectId) ? next.projectId : '',
      };
      writeFilters(filters);
      const data = await loadDashboardData(filters, COST_ROLES.has(state.role));
      setState({ ...state, data, filters, projects, status: 'ready' });
    } catch (error) {
      setState({
        status: isAccessError(error) ? 'permission' : 'error',
      });
    }
  }

  if (state.status === 'loading') return <Panel busy title="正在加载工作台" />;
  if (state.status === 'permission') return <Panel title="无权查看当前工作台" />;
  if (state.status === 'error') return <Panel title="无法加载工作台" />;
  if (state.status === 'empty') return <Panel title="暂无可用工作区" />;
  if (state.status !== 'ready') return null;

  const packages = withinRange(state.data.packages, state.filters.from, state.filters.to);
  const failed = packages.filter((item) => FAILURE_STATUSES.has(item.status));
  const inReview = packages.filter((item) => item.status === 'in_review');
  const publishingTodos = packages.filter((item) => PUBLISH_TODO_STATUSES.has(item.status));
  const latest = [...packages].sort((left, right) =>
    right.updated_at.localeCompare(left.updated_at),
  )[0];
  const latestFailed = [...failed].sort((left, right) =>
    right.updated_at.localeCompare(left.updated_at),
  )[0];

  return (
    <div>
      <section
        aria-label="工作台筛选"
        className="grid gap-4 rounded-2xl border border-line bg-white p-5 shadow-panel sm:grid-cols-2 lg:grid-cols-4"
      >
        <Filter label="开始日期">
          <input
            aria-label="开始日期"
            className="h-10 w-full rounded-control border border-line px-3"
            max={state.filters.to}
            onChange={(event) => void updateFilters({ ...state.filters, from: event.target.value })}
            type="date"
            value={state.filters.from}
          />
        </Filter>
        <Filter label="结束日期">
          <input
            aria-label="结束日期"
            className="h-10 w-full rounded-control border border-line px-3"
            min={state.filters.from}
            onChange={(event) => void updateFilters({ ...state.filters, to: event.target.value })}
            type="date"
            value={state.filters.to}
          />
        </Filter>
        <Filter label="工作区">
          <select
            aria-label="工作区"
            className="h-10 w-full rounded-control border border-line bg-white px-3"
            onChange={(event) =>
              void updateFilters({
                ...state.filters,
                projectId: '',
                workspaceId: event.target.value,
              })
            }
            value={state.filters.workspaceId}
          >
            {state.workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </Filter>
        <Filter label="项目">
          <select
            aria-label="项目"
            className="h-10 w-full rounded-control border border-line bg-white px-3"
            onChange={(event) =>
              void updateFilters({ ...state.filters, projectId: event.target.value })
            }
            value={state.filters.projectId}
          >
            <option value="">全部项目</option>
            {state.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </Filter>
      </section>

      <section aria-label="工作台指标" className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="内容产能" value={`${packages.length} 个内容包`} />
        <MetricCard label="失败任务" value={`${failed.length} 项`} />
        {REVIEW_ROLES.has(state.role) ? (
          <MetricCard href="/rev-01" label="审核待办" value={`${inReview.length} 项`} />
        ) : null}
        {PUBLISH_ROLES.has(state.role) ? (
          <MetricCard href="/pub-03" label="发布待办" value={`${publishingTodos.length} 项`} />
        ) : null}
        {COST_ROLES.has(state.role) ? (
          <MetricCard label="已结算成本" value={formatCost(state.data.costCents ?? 0)} />
        ) : null}
      </section>

      <section className="mt-6 grid gap-4 lg:grid-cols-2" aria-label="工作台快捷入口">
        <ActionPanel title="下一步动作">
          <div className="flex flex-wrap gap-3">
            {REVIEW_ROLES.has(state.role) ? <ActionLink href="/rev-01">进入审核</ActionLink> : null}
            {PUBLISH_ROLES.has(state.role) ? (
              <ActionLink href="/pub-03">进入发布</ActionLink>
            ) : null}
            {latest ? (
              <ActionLink href={`/cont-04?id=${latest.id}`}>查看最新内容</ActionLink>
            ) : null}
          </div>
        </ActionPanel>
        <ActionPanel title="失败任务">
          {latestFailed ? (
            <div className="flex items-center justify-between gap-4 text-sm">
              <div>
                <p className="font-medium text-ink-950">内容包 {latestFailed.id.slice(0, 8)}</p>
                <p className="mt-1 text-ink-500">{statusLabel(latestFailed.status)}</p>
              </div>
              <ActionLink href={`/cont-04?id=${latestFailed.id}`}>查看详情</ActionLink>
            </div>
          ) : (
            <p className="text-sm text-ink-500">当前筛选范围内没有失败任务。</p>
          )}
        </ActionPanel>
      </section>
      <p className="mt-4 text-xs text-ink-500">内容统计基于当前授权范围内最近 100 个内容包。</p>
    </div>
  );
}

function Filter({
  children,
  label,
}: {
  readonly children: React.ReactNode;
  readonly label: string;
}) {
  return (
    <label className="text-sm font-medium text-ink-700">
      <span className="mb-2 block">{label}</span>
      {children}
    </label>
  );
}

function MetricCard({
  href,
  label,
  value,
}: {
  readonly href?: string;
  readonly label: string;
  readonly value: string;
}) {
  const body = (
    <>
      <p className="text-sm font-medium text-ink-500">{label}</p>
      <p className="mt-3 text-2xl font-semibold tracking-tight text-ink-950">{value}</p>
      {href ? <p className="mt-3 text-sm font-medium text-brand-700">查看详情</p> : null}
    </>
  );
  const className = 'rounded-2xl border border-line bg-white p-5 shadow-panel';
  return href ? (
    <Link className={className} href={href}>
      {body}
    </Link>
  ) : (
    <article className={className}>{body}</article>
  );
}

function ActionPanel({
  children,
  title,
}: {
  readonly children: React.ReactNode;
  readonly title: string;
}) {
  return (
    <section className="rounded-2xl border border-line bg-white p-5 shadow-panel">
      <h2 className="font-semibold text-ink-950">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function ActionLink({
  children,
  href,
}: {
  readonly children: React.ReactNode;
  readonly href: string;
}) {
  return (
    <Link
      className="inline-flex min-h-10 items-center rounded-control border border-brand-100 bg-brand-50 px-4 text-sm font-semibold text-brand-700"
      href={href}
    >
      {children}
    </Link>
  );
}

function Panel({ busy = false, title }: { readonly busy?: boolean; readonly title: string }) {
  return (
    <div
      aria-busy={busy || undefined}
      className="rounded-2xl border border-line bg-white p-10 text-center text-ink-500"
      role="status"
    >
      <p>{title}</p>
    </div>
  );
}

function filtersFromLocation(): DashboardFilters {
  const query = new URLSearchParams(window.location.search);
  const today = new Date();
  const to = validDate(query.get('to')) ?? toDate(today);
  const from = validDate(query.get('from')) ?? toDate(new Date(today.getTime() - 29 * 86_400_000));
  return {
    from: from <= to ? from : to,
    projectId: query.get('project_id') ?? '',
    to,
    workspaceId: query.get('workspace_id') ?? '',
  };
}

function writeFilters(filters: DashboardFilters) {
  const query = new URLSearchParams({
    from: filters.from,
    to: filters.to,
    workspace_id: filters.workspaceId,
  });
  if (filters.projectId) query.set('project_id', filters.projectId);
  window.history.replaceState(null, '', `/dash-01?${query}`);
}

function withinRange(packages: readonly DashboardContentPackage[], from: string, to: string) {
  return packages.filter((item) => {
    const day = item.created_at.slice(0, 10);
    return day >= from && day <= to;
  });
}

function validDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function toDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function formatCost(cents: number) {
  return new Intl.NumberFormat('zh-CN', { currency: 'CNY', style: 'currency' }).format(cents / 100);
}

function statusLabel(status: DashboardContentPackage['status']) {
  return status === 'all_failed'
    ? '生成全部失败'
    : status === 'publish_failed'
      ? '发布失败'
      : status;
}

function isAccessError(error: unknown): boolean {
  if (error instanceof DashboardRequestError) return [401, 403, 404].includes(error.status);
  if (!error || typeof error !== 'object') return false;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && [401, 403, 404].includes(status);
}
