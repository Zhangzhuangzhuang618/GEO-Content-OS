'use client';

import { useEffect, useState } from 'react';

import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import { listProjects } from '../dash-01/dashboard-api';
import type { DashboardProject } from '../dash-01/dashboard.schema';
import { listAiVisibilityQuerySets } from '../anl-03/ai-visibility-api';
import type { AiVisibilityQuerySet } from '../anl-03/ai-visibility.schema';
import { listWorkspaces } from '../set-02/workspace-settings-api';
import type { Workspace } from '../set-02/workspace-settings.schema';
import {
  WentianRequestError,
  disconnectWentianBinding,
  issueWentianSsoTicket,
  loadWentianStatus,
  refreshWentianBinding,
  requestWentianBinding,
  syncWentianQuerySet,
} from './wentian-api';
import type { WentianBinding, WentianConnectorStatus } from './wentian.schema';

const ADMIN_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin']);
const ENTRY_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'analyst', 'viewer']);
const STATUS_COPY: Readonly<
  Record<WentianBinding['status'], { readonly label: string; readonly text: string }>
> = {
  active: { label: '已连接', text: '可以进入问天，也可以把当前问题集同步到问天。' },
  disconnected: { label: '已断开', text: '历史数据仍保留；需要时可以重新申请连接。' },
  pending_wentian: {
    label: '等待问天确认',
    text: '请在问天管理端选择对应项目并批准。GEO 不会自动猜测项目。',
  },
  rejected: { label: '申请未通过', text: '查看原因后，可以重新发起连接申请。' },
  suspended: { label: '连接已暂停', text: '当前不能进入或同步，请刷新状态或联系问天管理员。' },
};

type PageState = 'loading' | 'ready' | 'empty' | 'error';

export function WentianConnector() {
  const [state, setState] = useState<PageState>('loading');
  const [role, setRole] = useState<TenantRole | null>(null);
  const [workspaces, setWorkspaces] = useState<readonly Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [projects, setProjects] = useState<readonly DashboardProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [status, setStatus] = useState<WentianConnectorStatus | null>(null);
  const [querySets, setQuerySets] = useState<readonly AiVisibilityQuerySet[]>([]);
  const [querySetId, setQuerySetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void bootstrap(controller.signal);
    return () => controller.abort();
  }, []);

  async function bootstrap(signal: AbortSignal) {
    try {
      const [tenants, availableWorkspaces] = await Promise.all([
        listAvailableTenants(signal),
        listWorkspaces(signal),
      ]);
      setRole(tenants.find((item) => item.is_active)?.role_code ?? null);
      const active = availableWorkspaces.filter((item) => item.status === 'active');
      setWorkspaces(active);
      if (active.length === 0) return setState('empty');
      const workspace = active[0]!.id;
      setWorkspaceId(workspace);
      await loadWorkspace(workspace, signal);
      setState('ready');
    } catch {
      if (!signal.aborted) setState('error');
    }
  }

  async function loadWorkspace(workspace: string, signal?: AbortSignal) {
    const availableProjects = await listProjects(workspace, signal);
    setProjects(availableProjects);
    const project = availableProjects[0]?.id ?? '';
    setProjectId(project);
    if (project) await loadProject(workspace, project, signal);
    else clearProject();
  }

  async function loadProject(workspace: string, project: string, signal?: AbortSignal) {
    const connectorStatus = await loadWentianStatus(
      { projectId: project, workspaceId: workspace },
      signal,
    );
    setStatus(connectorStatus);
    setConfirmDisconnect(false);
    if (connectorStatus.binding?.status === 'active') {
      await loadQuerySets(workspace, project, signal);
    } else {
      setQuerySets([]);
      setQuerySetId('');
    }
  }

  async function loadQuerySets(workspace: string, project: string, signal?: AbortSignal) {
    const sets = (await listAiVisibilityQuerySets(workspace, project, signal)).filter(
      (item) => item.status === 'active',
    );
    setQuerySets(sets);
    setQuerySetId(sets[0]?.id ?? '');
  }

  function clearProject() {
    setStatus(null);
    setQuerySets([]);
    setQuerySetId('');
    setConfirmDisconnect(false);
  }

  async function changeWorkspace(next: string) {
    setWorkspaceId(next);
    setProjectId('');
    clearProject();
    await run('正在读取项目…', () => loadWorkspace(next));
  }

  async function changeProject(next: string) {
    setProjectId(next);
    clearProject();
    if (next) await run('正在读取连接状态…', () => loadProject(workspaceId, next));
  }

  async function createBinding() {
    await mutate('连接申请已提交。请到问天管理端选择对应项目并批准。', async (csrf) => {
      const binding = await requestWentianBinding(scope(), csrf);
      updateBinding(binding);
    });
  }

  async function refreshBinding() {
    const binding = status?.binding;
    if (!binding) return;
    await mutate('连接状态已更新。', async (csrf) => {
      const refreshed = await refreshWentianBinding(binding.id, scope(), csrf);
      updateBinding(refreshed);
      if (refreshed.status === 'active') await loadQuerySets(workspaceId, projectId);
    });
  }

  async function enterWentian() {
    await mutate(null, async (csrf) => {
      const ticket = await issueWentianSsoTicket(scope(), csrf);
      window.location.assign(ticket.launch_url);
    });
  }

  async function syncQuerySet() {
    if (!querySetId) return setMessage('请先选择一个问题集。');
    await mutate('问题集已作为不可变快照同步到问天。', async (csrf) => {
      const latestSync = await syncWentianQuerySet({ ...scope(), querySetId }, csrf);
      setStatus((current) => (current ? { ...current, latest_sync: latestSync } : current));
    });
  }

  async function disconnect() {
    const binding = status?.binding;
    if (!binding) return;
    if (!confirmDisconnect) {
      setConfirmDisconnect(true);
      setMessage('再次点击“确认断开”完成操作。问天中的项目和历史实验不会被删除。');
      return;
    }
    await mutate('连接已断开；问天项目和历史实验仍保留。', async (csrf) => {
      updateBinding(await disconnectWentianBinding(binding.id, csrf));
      setConfirmDisconnect(false);
      setQuerySets([]);
      setQuerySetId('');
    });
  }

  async function mutate(successMessage: string | null, action: (csrf: string) => Promise<void>) {
    const csrf = cookie('geo_csrf');
    if (!csrf) return setMessage('登录安全令牌尚未就绪，请刷新页面。');
    setBusy(true);
    setMessage(null);
    try {
      await action(csrf);
      if (successMessage) setMessage(successMessage);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function run(progress: string, action: () => Promise<void>) {
    setBusy(true);
    setMessage(progress);
    try {
      await action();
      setMessage(null);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function scope() {
    return { projectId, workspaceId };
  }

  function updateBinding(binding: WentianBinding) {
    setStatus((current) => (current ? { ...current, binding } : current));
  }

  if (state === 'loading') return <Notice title="正在读取问天连接状态" text="请稍候。" />;
  if (state === 'error')
    return <Notice title="暂时无法读取问天连接状态" text="请检查登录状态和服务连接。" />;
  if (state === 'empty') return <Notice title="暂无可用工作区" text="请先创建或启用一个工作区。" />;

  const admin = role ? ADMIN_ROLES.has(role) : false;
  const canEnter = role ? ENTRY_ROLES.has(role) : false;
  const binding = status?.binding ?? null;
  const connected = binding?.status === 'active';

  return (
    <section className="mt-8 space-y-5">
      <div className="grid gap-4 rounded-2xl border border-line bg-white p-5 shadow-panel sm:grid-cols-2">
        <Select
          disabled={busy}
          label="工作区"
          onChange={(value) => void changeWorkspace(value)}
          value={workspaceId}
        >
          {workspaces.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </Select>
        <Select
          disabled={busy}
          label="项目"
          onChange={(value) => void changeProject(value)}
          value={projectId}
        >
          {projects.length === 0 ? <option value="">暂无项目</option> : null}
          {projects.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </Select>
      </div>

      {message ? (
        <p
          aria-live="polite"
          className="rounded-xl border border-line bg-white px-4 py-3 text-sm text-ink-700"
        >
          {message}
        </p>
      ) : null}

      {!projectId ? (
        <Notice title="当前工作区没有项目" text="请先创建项目，再连接问天。" />
      ) : !status ? (
        <Notice title="正在读取连接状态" text="请稍候。" />
      ) : status.configuration_status === 'not_configured' ? (
        <Notice
          title="问天连接器尚未配置"
          text="GEO 管理员需要在服务端填写问天地址、连接器编号、密钥和对应企业。其他功能不受影响。"
        />
      ) : status.configuration_status === 'invalid' ? (
        <Notice
          title="问天连接器配置无效"
          text="请由系统管理员检查问天地址、连接器编号、密钥和企业配置。其他功能不受影响。"
        />
      ) : (
        <div className="rounded-2xl border border-line bg-white p-5 shadow-panel sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-brand-700">项目连接</p>
              <h2 className="mt-1 text-2xl font-semibold text-ink-950">
                {binding ? STATUS_COPY[binding.status].label : '尚未连接'}
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-600">
                {binding
                  ? STATUS_COPY[binding.status].text
                  : '发起申请后，需要问天管理员明确选择一个问天项目并批准。'}
              </p>
              {binding?.decision_reason ? (
                <p className="mt-3 rounded-xl bg-surface-subtle px-4 py-3 text-sm text-ink-700">
                  处理说明：{binding.decision_reason}
                </p>
              ) : null}
            </div>
            <span
              className={`rounded-full px-3 py-1.5 text-xs font-semibold ${connected ? 'bg-emerald-50 text-emerald-700' : 'bg-surface-subtle text-ink-600'}`}
            >
              {binding ? STATUS_COPY[binding.status].label : '未连接'}
            </span>
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            {admin && (!binding || ['rejected', 'disconnected'].includes(binding.status)) ? (
              <Button busy={busy} onClick={() => void createBinding()}>
                申请连接
              </Button>
            ) : null}
            {admin &&
            binding &&
            ['pending_wentian', 'active', 'suspended'].includes(binding.status) ? (
              <Button busy={busy} kind="secondary" onClick={() => void refreshBinding()}>
                刷新状态
              </Button>
            ) : null}
            {connected && canEnter ? (
              <Button busy={busy} onClick={() => void enterWentian()}>
                进入问天
              </Button>
            ) : null}
            {admin &&
            binding &&
            ['pending_wentian', 'active', 'suspended'].includes(binding.status) ? (
              <Button busy={busy} kind="danger" onClick={() => void disconnect()}>
                {confirmDisconnect
                  ? '确认断开'
                  : binding.status === 'pending_wentian'
                    ? '撤回申请'
                    : '断开连接'}
              </Button>
            ) : null}
          </div>

          {!admin ? (
            <p className="mt-4 text-sm text-ink-500">连接、同步和断开由企业管理员或所有者操作。</p>
          ) : null}

          {connected && admin ? (
            <div className="mt-8 border-t border-line pt-6">
              <h3 className="text-lg font-semibold text-ink-950">同步 AI 可见度问题集</h3>
              <p className="mt-1 text-sm leading-6 text-ink-600">
                每次同步都会在问天生成不可变快照，不会覆盖已完成实验所用的问题。
              </p>
              {querySets.length === 0 ? (
                <p className="mt-4 rounded-xl bg-surface-subtle px-4 py-3 text-sm text-ink-600">
                  当前项目还没有可同步的问题集。请先在“AI 可见度”中创建。
                </p>
              ) : (
                <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
                  <div className="min-w-0 flex-1">
                    <Select
                      disabled={busy}
                      label="选择问题集"
                      onChange={setQuerySetId}
                      value={querySetId}
                    >
                      {querySets.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}（{item.query_count} 问 · 第 {item.revision} 版）
                        </option>
                      ))}
                    </Select>
                  </div>
                  <Button busy={busy} onClick={() => void syncQuerySet()}>
                    同步到问天
                  </Button>
                </div>
              )}
              {status.latest_sync ? (
                <p className="mt-4 text-sm text-ink-500">
                  最近同步：{formatDate(status.latest_sync.synced_at)}，共{' '}
                  {status.latest_sync.query_count} 个问题。
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function Select(props: {
  readonly children: React.ReactNode;
  readonly disabled: boolean;
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly value: string;
}) {
  return (
    <label className="block text-sm font-medium text-ink-700">
      {props.label}
      <select
        className="mt-2 min-h-11 w-full rounded-control border border-line bg-white px-3 text-sm text-ink-950 disabled:bg-surface-subtle"
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        value={props.value}
      >
        {props.children}
      </select>
    </label>
  );
}

function Button(props: {
  readonly busy: boolean;
  readonly children: React.ReactNode;
  readonly kind?: 'primary' | 'secondary' | 'danger';
  readonly onClick: () => void;
}) {
  const kind = props.kind ?? 'primary';
  const colors = {
    danger: 'border border-red-200 bg-white text-red-700 hover:bg-red-50',
    primary: 'bg-brand-600 text-white hover:bg-brand-700',
    secondary: 'border border-line bg-white text-ink-700 hover:bg-surface-subtle',
  }[kind];
  return (
    <button
      className={`min-h-11 rounded-control px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${colors}`}
      disabled={props.busy}
      onClick={props.onClick}
      type="button"
    >
      {props.children}
    </button>
  );
}

function Notice(props: { readonly text: string; readonly title: string }) {
  return (
    <section className="mt-8 rounded-2xl border border-line bg-white p-6 shadow-panel">
      <h2 className="text-xl font-semibold text-ink-950">{props.title}</h2>
      <p className="mt-2 text-sm leading-6 text-ink-600">{props.text}</p>
    </section>
  );
}

function cookie(name: string): string {
  const prefix = `${name}=`;
  return (
    document.cookie
      .split(';')
      .map((item) => item.trim())
      .find((item) => item.startsWith(prefix))
      ?.slice(prefix.length) ?? ''
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof WentianRequestError) {
    if (error.code === 'WENTIAN_CONNECTOR_NOT_CONFIGURED') return '问天连接器尚未正确配置。';
    if (error.code === 'WENTIAN_BINDING_CONFLICT') return '当前项目已有待确认或有效连接。';
    if (error.status === 403) return '当前账号没有执行此操作的权限。';
    if (error.status === 404) return '连接记录不存在，可能已在另一端处理。请刷新状态。';
    if (error.status === 502 || error.status === 503)
      return '问天暂时不可用；GEO 其他功能不受影响。';
  }
  return '操作未完成，请稍后重试。';
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}
