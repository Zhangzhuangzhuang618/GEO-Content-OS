'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import {
  currentApplicationPath,
  expiredSessionLoginPath,
  tenantEntryPath,
} from '../auth-navigation';
import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import { listWorkspaces } from '../set-02/workspace-settings-api';
import type { Workspace } from '../set-02/workspace-settings.schema';
import {
  DashboardRequestError,
  listContentPackages,
  listProjects,
  loadCostCents,
} from './dashboard-api';
import type {
  DashboardContentPackage,
  DashboardData,
  DashboardFilters,
  DashboardProject,
} from './dashboard.schema';
import { QuickCreate } from './quick-create';

const COST_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'analyst']);
const REVIEW_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'reviewer']);
const PUBLISH_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'publisher']);
const FAILURE_STATUSES = new Set(['all_failed', 'publish_failed']);
const PUBLISH_TODO_STATUSES = new Set(['scheduled', 'publishing', 'publish_failed']);

interface ReadyState {
  readonly data: DashboardData;
  readonly filters: DashboardFilters;
  readonly issues: DashboardIssues;
  readonly projects: readonly DashboardProject[];
  readonly refreshing: boolean;
  readonly role: TenantRole;
  readonly status: 'ready';
  readonly tenantName: string;
  readonly workspaces: readonly Workspace[];
}

interface DashboardIssues {
  readonly cost: boolean;
  readonly packages: boolean;
  readonly projects: boolean;
}

type State =
  | { readonly message: string; readonly status: 'error' }
  | { readonly role: TenantRole; readonly status: 'empty'; readonly tenantName: string }
  | { readonly status: 'loading' | 'permission' }
  | ReadyState;

type Attempt<T> =
  { readonly ok: false; readonly error: unknown } | { readonly ok: true; readonly value: T };

export function Dashboard() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [initialTopic, setInitialTopic] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setInitialTopic(new URLSearchParams(window.location.search).get('topic')?.slice(0, 80) ?? '');
    void bootstrap(controller.signal);
    return () => controller.abort();
  }, []);

  async function bootstrap(signal?: AbortSignal) {
    setState({ status: 'loading' });
    const tenantsResult = await attempt(listAvailableTenants(signal));
    if (signal?.aborted) return;
    if (!tenantsResult.ok) return handleEssentialError(tenantsResult.error);

    const activeTenant = tenantsResult.value.find((tenant) => tenant.is_active);
    if (!activeTenant) {
      window.location.replace(tenantEntryPath(currentApplicationPath(window.location), true));
      return;
    }

    const workspacesResult = await attempt(listWorkspaces(signal));
    if (signal?.aborted) return;
    if (!workspacesResult.ok) return handleEssentialError(workspacesResult.error);
    const activeWorkspaces = workspacesResult.value.filter(
      (workspace) => workspace.status === 'active',
    );
    if (activeWorkspaces.length === 0) {
      setState({
        role: activeTenant.role_code,
        status: 'empty',
        tenantName: activeTenant.name,
      });
      return;
    }

    const requested = filtersFromLocation();
    const workspaceId = activeWorkspaces.some((item) => item.id === requested.workspaceId)
      ? requested.workspaceId
      : activeWorkspaces[0]!.id;
    const projectsResult = await attempt(listProjects(workspaceId, signal));
    if (!projectsResult.ok && redirectForExpiredSession(projectsResult.error)) return;
    const projects = projectsResult.ok ? projectsResult.value : [];
    const projectId = projects.some((item) => item.id === requested.projectId)
      ? requested.projectId
      : '';
    const filters = { ...requested, projectId, workspaceId };
    writeFilters(filters);
    const sections = await loadSections(filters, COST_ROLES.has(activeTenant.role_code), signal);
    if (signal?.aborted || redirectForExpiredSession(sections.error)) return;
    setState({
      data: sections.data,
      filters,
      issues: {
        ...sections.issues,
        projects: !projectsResult.ok,
      },
      projects,
      refreshing: false,
      role: activeTenant.role_code,
      status: 'ready',
      tenantName: activeTenant.name,
      workspaces: activeWorkspaces,
    });
  }

  async function updateFilters(next: DashboardFilters) {
    if (state.status !== 'ready') return;
    const previous = state;
    setState({ ...previous, refreshing: true });
    writeFilters(next);
    const projectsResult =
      next.workspaceId === previous.filters.workspaceId
        ? ({ ok: true, value: previous.projects } as const)
        : await attempt(listProjects(next.workspaceId));
    if (!projectsResult.ok && redirectForExpiredSession(projectsResult.error)) return;
    const projects = projectsResult.ok ? projectsResult.value : [];
    const filters = {
      ...next,
      projectId: projects.some((project) => project.id === next.projectId) ? next.projectId : '',
    };
    writeFilters(filters);
    const sections = await loadSections(filters, COST_ROLES.has(previous.role));
    if (redirectForExpiredSession(sections.error)) return;
    setState({
      ...previous,
      data: sections.data,
      filters,
      issues: { ...sections.issues, projects: !projectsResult.ok },
      projects,
      refreshing: false,
    });
  }

  async function retrySection(section: 'cost' | 'packages' | 'projects') {
    if (state.status !== 'ready') return;
    const current = state;
    if (section === 'projects') {
      const result = await attempt(listProjects(current.filters.workspaceId));
      if (!result.ok && redirectForExpiredSession(result.error)) return;
      setState({
        ...current,
        issues: { ...current.issues, projects: !result.ok },
        projects: result.ok ? result.value : current.projects,
      });
      return;
    }
    if (section === 'packages') {
      const result = await attempt(listContentPackages(current.filters));
      if (!result.ok && redirectForExpiredSession(result.error)) return;
      setState({
        ...current,
        data: {
          ...current.data,
          packages: result.ok ? result.value : current.data.packages,
        },
        issues: { ...current.issues, packages: !result.ok },
      });
      return;
    }
    const result = await attempt(loadCostCents(current.filters));
    if (!result.ok && redirectForExpiredSession(result.error)) return;
    setState({
      ...current,
      data: {
        ...current.data,
        costCents: result.ok ? result.value : current.data.costCents,
      },
      issues: { ...current.issues, cost: !result.ok },
    });
  }

  function handleEssentialError(error: unknown) {
    if (redirectForExpiredSession(error)) return;
    if (isAccessError(error)) {
      setState({ status: 'permission' });
      return;
    }
    setState({ message: '暂时无法加载工作空间，请稍后重试。', status: 'error' });
  }

  function redirectForExpiredSession(error: unknown): boolean {
    if (requestStatus(error) !== 401) return false;
    window.location.replace(expiredSessionLoginPath(currentApplicationPath(window.location)));
    return true;
  }

  if (state.status === 'loading') {
    return <Panel busy description="正在确认企业和工作空间。" title="正在加载工作台" />;
  }
  if (state.status === 'permission') {
    return (
      <Panel
        description="当前账号没有访问该企业工作台的权限，你可以切换企业或联系管理员。"
        href="/auth-02"
        linkLabel="切换企业"
        title="无权查看当前工作台"
      />
    );
  }
  if (state.status === 'error') {
    return (
      <Panel
        description={state.message}
        onRetry={() => void bootstrap()}
        title="工作台暂时不可用"
      />
    );
  }
  if (state.status === 'empty') return <EmptyWorkspace state={state} />;
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
  const selectedWorkspace = state.workspaces.find((item) => item.id === state.filters.workspaceId);
  const selectedProject = state.projects.find((item) => item.id === state.filters.projectId);

  return (
    <div>
      <QuickCreate
        initialProjectId={state.filters.projectId}
        initialProjects={state.projects}
        initialTopic={initialTopic}
        initialWorkspaceId={state.filters.workspaceId}
        role={state.role}
        workspaces={state.workspaces}
      />
      <section
        aria-label="当前创作范围"
        className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-line bg-white px-5 py-4 shadow-panel"
      >
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <div>
            <p className="text-xs font-medium text-ink-500">当前企业</p>
            <p className="mt-1 font-semibold text-ink-950">{state.tenantName}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-ink-500">默认创作位置</p>
            <p className="mt-1 text-sm font-medium text-ink-700">
              {selectedWorkspace?.name ?? '当前工作区'}
              {selectedProject ? ` / ${selectedProject.name}` : ''}
            </p>
          </div>
        </div>
        <Link className="text-sm font-semibold text-brand-700 hover:text-brand-600" href="/auth-02">
          切换企业
        </Link>
      </section>

      <section aria-labelledby="next-actions-title" className="mt-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-ink-950" id="next-actions-title">
              接下来建议处理
            </h2>
            <p className="mt-1 text-sm text-ink-500">优先展示需要你处理的异常、审核和发布事项。</p>
          </div>
          <Link className="text-sm font-semibold text-brand-700" href="/cont-03">
            查看全部内容
          </Link>
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <NextActionCard
            count={failed.length}
            description={
              latestFailed
                ? `${statusLabel(latestFailed.status)}，打开后可以查看原因并继续处理。`
                : '当前没有生成或发布失败的内容。'
            }
            href={latestFailed ? `/cont-04?id=${latestFailed.id}` : '/cont-03'}
            label="需要处理的异常"
            tone={failed.length ? 'danger' : 'success'}
          />
          {REVIEW_ROLES.has(state.role) ? (
            <NextActionCard
              count={inReview.length}
              description={
                inReview.length
                  ? '内容正在等待审核，可以进入待办逐项处理。'
                  : '当前没有待审核内容。'
              }
              href="/rev-01"
              label="等待审核"
              tone={inReview.length ? 'attention' : 'neutral'}
            />
          ) : null}
          {PUBLISH_ROLES.has(state.role) ? (
            <NextActionCard
              count={publishingTodos.length}
              description={
                publishingTodos.length
                  ? '包含已排期、发布中或发布失败的内容。'
                  : '当前没有需要处理的发布任务。'
              }
              href="/pub-02"
              label="发布任务"
              tone={publishingTodos.length ? 'attention' : 'neutral'}
            />
          ) : null}
          <NextActionCard
            count={packages.length}
            description={latest ? '继续处理最近更新的内容。' : '从上方填写一个主题开始创作。'}
            href={latest ? `/cont-04?id=${latest.id}` : '#create-content'}
            label="最近内容"
            tone="brand"
          />
        </div>
      </section>

      <details className="group mt-6 overflow-hidden rounded-2xl border border-line bg-white shadow-panel">
        <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 px-5 py-4">
          <div>
            <p className="font-semibold text-ink-950">工作概览与筛选</p>
            <p className="mt-1 text-sm text-ink-500">
              查看近 30 天数据，或切换时间、工作区和项目。
            </p>
          </div>
          <span className="text-sm font-semibold text-brand-700 group-open:hidden">展开</span>
          <span className="hidden text-sm font-semibold text-brand-700 group-open:inline">
            收起
          </span>
        </summary>
        <div className="border-t border-line p-5">
          <section aria-label="工作台筛选" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Filter label="开始日期">
              <input
                aria-label="开始日期"
                className="h-10 w-full rounded-control border border-line px-3"
                max={state.filters.to}
                onChange={(event) =>
                  void updateFilters({ ...state.filters, from: event.target.value })
                }
                type="date"
                value={state.filters.from}
              />
            </Filter>
            <Filter label="结束日期">
              <input
                aria-label="结束日期"
                className="h-10 w-full rounded-control border border-line px-3"
                min={state.filters.from}
                onChange={(event) =>
                  void updateFilters({ ...state.filters, to: event.target.value })
                }
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
                disabled={state.issues.projects}
                onChange={(event) =>
                  void updateFilters({ ...state.filters, projectId: event.target.value })
                }
                value={state.filters.projectId}
              >
                <option value="">
                  {state.issues.projects ? '项目列表暂时不可用' : '全部项目'}
                </option>
                {state.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
              {state.issues.projects ? (
                <button
                  className="mt-2 text-sm font-semibold text-brand-700"
                  onClick={() => void retrySection('projects')}
                  type="button"
                >
                  重新加载项目
                </button>
              ) : null}
            </Filter>
          </section>

          {state.refreshing ? (
            <p aria-live="polite" className="mt-3 text-sm text-ink-500" role="status">
              正在更新筛选结果…
            </p>
          ) : null}

          <section
            aria-label="工作台指标"
            className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
          >
            <MetricCard
              error={state.issues.packages}
              label="内容任务"
              onRetry={() => void retrySection('packages')}
              value={state.issues.packages ? '暂时无法获取' : `${packages.length} 项`}
            />
            <MetricCard
              error={state.issues.packages}
              label="需要处理"
              onRetry={() => void retrySection('packages')}
              value={state.issues.packages ? '暂时无法获取' : `${failed.length} 项`}
            />
            {REVIEW_ROLES.has(state.role) ? (
              <MetricCard
                error={state.issues.packages}
                href="/rev-01"
                label="等待审核"
                onRetry={() => void retrySection('packages')}
                value={state.issues.packages ? '暂时无法获取' : `${inReview.length} 项`}
              />
            ) : null}
            {PUBLISH_ROLES.has(state.role) ? (
              <MetricCard
                error={state.issues.packages}
                href="/pub-02"
                label="发布任务"
                onRetry={() => void retrySection('packages')}
                value={state.issues.packages ? '暂时无法获取' : `${publishingTodos.length} 项`}
              />
            ) : null}
            {COST_ROLES.has(state.role) ? (
              <MetricCard
                error={state.issues.cost}
                label="已结算成本"
                onRetry={() => void retrySection('cost')}
                value={state.issues.cost ? '暂时无法获取' : formatCost(state.data.costCents ?? 0)}
              />
            ) : null}
          </section>
        </div>
      </details>
      <p className="mt-4 text-xs text-ink-500">内容统计基于当前可访问的最近 100 项内容任务。</p>
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
    <div className="text-sm font-medium text-ink-700">
      <span className="mb-2 block">{label}</span>
      {children}
    </div>
  );
}

function MetricCard({
  error = false,
  href,
  label,
  onRetry,
  value,
}: {
  readonly error?: boolean;
  readonly href?: string;
  readonly label: string;
  readonly onRetry?: () => void;
  readonly value: string;
}) {
  const body = (
    <>
      <p className="text-sm font-medium text-ink-500">{label}</p>
      <p className="mt-3 text-2xl font-semibold tracking-tight text-ink-950">{value}</p>
      {error && onRetry ? (
        <button
          className="mt-3 text-sm font-semibold text-brand-700"
          onClick={onRetry}
          type="button"
        >
          重新加载
        </button>
      ) : href ? (
        <p className="mt-3 text-sm font-medium text-brand-700">查看详情</p>
      ) : null}
    </>
  );
  const className = 'rounded-2xl border border-line bg-white p-5 shadow-panel';
  return href && !error ? (
    <Link className={className} href={href}>
      {body}
    </Link>
  ) : (
    <article className={className}>{body}</article>
  );
}

function NextActionCard({
  count,
  description,
  href,
  label,
  tone,
}: {
  readonly count: number;
  readonly description: string;
  readonly href: string;
  readonly label: string;
  readonly tone: 'attention' | 'brand' | 'danger' | 'neutral' | 'success';
}) {
  const toneClass = {
    attention: 'border-amber-200 bg-amber-50/70 text-amber-800',
    brand: 'border-brand-100 bg-brand-50 text-brand-800',
    danger: 'border-red-200 bg-red-50 text-red-700',
    neutral: 'border-line bg-white text-ink-700',
    success: 'border-emerald-200 bg-emerald-50/70 text-emerald-700',
  }[tone];
  return (
    <Link
      className={`group rounded-2xl border p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-panel ${toneClass}`}
      href={href}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="font-semibold">{label}</p>
        <span className="text-2xl font-semibold tracking-tight">{count}</span>
      </div>
      <p className="mt-3 text-sm leading-6 opacity-80">{description}</p>
      <p className="mt-4 text-sm font-semibold group-hover:underline">
        {count > 0 ? '现在处理' : '查看'}
      </p>
    </Link>
  );
}

function EmptyWorkspace({
  state,
}: {
  readonly state: { readonly role: TenantRole; readonly tenantName: string };
}) {
  const canManage = state.role === 'tenant_owner' || state.role === 'tenant_admin';
  return (
    <Panel
      description={
        canManage
          ? `${state.tenantName} 还没有可用工作区。请先完成企业初始化，再开始配置项目和内容生产流程。`
          : `${state.tenantName} 还没有向你开放工作区，请联系企业管理员。`
      }
      href="/auth-02"
      linkLabel="切换企业"
      title="暂无可用工作区"
    />
  );
}

function Panel({
  busy = false,
  description,
  href,
  linkLabel,
  onRetry,
  title,
}: {
  readonly busy?: boolean;
  readonly description?: string;
  readonly href?: string;
  readonly linkLabel?: string;
  readonly onRetry?: () => void;
  readonly title: string;
}) {
  return (
    <div
      aria-busy={busy || undefined}
      className="rounded-2xl border border-line bg-white p-10 text-center text-ink-500"
      role="status"
    >
      <p className="font-semibold text-ink-950">{title}</p>
      {description ? <p className="mt-2 text-sm leading-6">{description}</p> : null}
      {onRetry ? (
        <button
          className="mt-5 rounded-control bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white"
          onClick={onRetry}
          type="button"
        >
          重新加载
        </button>
      ) : href && linkLabel ? (
        <Link
          className="mt-5 inline-flex rounded-control bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white"
          href={href}
        >
          {linkLabel}
        </Link>
      ) : null}
    </div>
  );
}

async function loadSections(
  filters: DashboardFilters,
  canReadCost: boolean,
  signal?: AbortSignal,
): Promise<{
  readonly data: DashboardData;
  readonly error: unknown;
  readonly issues: Pick<DashboardIssues, 'cost' | 'packages'>;
}> {
  const [packagesResult, costResult] = await Promise.all([
    attempt(listContentPackages(filters, signal)),
    canReadCost
      ? attempt(loadCostCents(filters, signal))
      : Promise.resolve({ ok: true, value: null } as const),
  ]);
  const packagesError = packagesResult.ok ? undefined : packagesResult.error;
  const costError = costResult.ok ? undefined : costResult.error;
  const error =
    requestStatus(packagesError) === 401
      ? packagesError
      : requestStatus(costError) === 401
        ? costError
        : (packagesError ?? costError);
  return {
    data: {
      costCents: costResult.ok ? costResult.value : null,
      packages: packagesResult.ok ? packagesResult.value : [],
    },
    error,
    issues: {
      cost: !costResult.ok,
      packages: !packagesResult.ok,
    },
  };
}

async function attempt<T>(promise: Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { error, ok: false };
  }
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
  return [401, 403, 404].includes(requestStatus(error) ?? 0);
}

function requestStatus(error: unknown): number | undefined {
  if (error instanceof DashboardRequestError) return error.status;
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}
