'use client';

import { useEffect, useState } from 'react';
import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import { listActiveWorkspaces } from '../str-02/brand-profile-api';
import { listProjects } from '../know-02/source-upload-api';
import { adjudicateFact, FactRequestError, listFacts, type FactFilters } from './fact-api';
import type { Fact, FactDecision, FactStatus } from './fact.schema';

const REVIEWER_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'reviewer']);

export function FactAdjudication() {
  const [filters, setFilters] = useState<FactFilters | null>(null);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'permission' | 'empty-scope' | 'error'>(
    'loading',
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const tenants = await listAvailableTenants(controller.signal);
        const role = tenants.find((tenant) => tenant.is_active)?.role_code;
        if (!role || !REVIEWER_ROLES.has(role)) {
          setState('permission');
          return;
        }
        const availableWorkspaces = await listActiveWorkspaces(controller.signal);
        setWorkspaces(availableWorkspaces);
        if (availableWorkspaces.length === 0) {
          setState('empty-scope');
          return;
        }
        const query = readQuery();
        const workspaceId = availableWorkspaces.some((item) => item.id === query.workspaceId)
          ? query.workspaceId
          : availableWorkspaces[0]!.id;
        const availableProjects = await listProjects(workspaceId, controller.signal);
        setProjects(availableProjects);
        if (availableProjects.length === 0) {
          setState('empty-scope');
          return;
        }
        const projectId = availableProjects.some((item) => item.id === query.projectId)
          ? query.projectId
          : availableProjects[0]!.id;
        const initial: FactFilters = {
          projectId,
          workspaceId,
          ...(query.search ? { search: query.search } : {}),
          ...(query.status ? { status: query.status } : {}),
        };
        setFilters(initial);
        writeQuery(initial);
        await load(initial, false, controller.signal);
      } catch {
        if (!controller.signal.aborted) setState('error');
      }
    })();
    return () => controller.abort();
  }, []);

  async function load(next: FactFilters, append = false, signal?: AbortSignal) {
    if (!append) setState('loading');
    const page = await listFacts(next, signal);
    if (signal?.aborted) return;
    setFacts((current) => (append ? [...current, ...page.items] : page.items));
    setNextCursor(page.nextCursor);
    setState('ready');
  }

  async function changeWorkspace(workspaceId: string) {
    setState('loading');
    setMessage(null);
    try {
      const availableProjects = await listProjects(workspaceId);
      setProjects(availableProjects);
      if (availableProjects.length === 0) {
        setFilters(null);
        setFacts([]);
        setState('empty-scope');
        return;
      }
      const next: FactFilters = { projectId: availableProjects[0]!.id, workspaceId };
      setFilters(next);
      writeQuery(next);
      await load(next);
    } catch {
      setState('error');
    }
  }

  function updateFilter(patch: {
    projectId?: string;
    search?: string;
    status?: FactStatus | null;
  }) {
    if (!filters) return;
    const next: FactFilters = { ...filters };
    delete next.cursor;
    if (patch.projectId) next.projectId = patch.projectId;
    if ('search' in patch) {
      if (patch.search) next.search = patch.search;
      else delete next.search;
    }
    if ('status' in patch) {
      if (patch.status) next.status = patch.status;
      else delete next.status;
    }
    setFilters(next);
    writeQuery(next);
    void load(next).catch(() => setState('error'));
  }

  async function mutate(fact: Fact, decision: FactDecision) {
    const reason = window.prompt(`${decisionLabel(decision)}理由（必填）`)?.trim();
    if (!reason) return;
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    setBusyId(fact.id);
    setMessage(null);
    try {
      const updated = await adjudicateFact(fact, decision, reason, csrf);
      setFacts((current) =>
        current.map((item) =>
          item.id === fact.id ? { ...updated, evidence: item.evidence } : item,
        ),
      );
      setMessage(`已${decisionLabel(decision)}；裁决前后值由服务端审计保留。`);
    } catch (error) {
      setMessage(
        error instanceof FactRequestError && [409, 422].includes(error.status)
          ? '裁决失败：事实版本、状态或证据已变化，请刷新后重试。'
          : '裁决失败，请稍后重试。',
      );
    } finally {
      setBusyId(null);
    }
  }

  if (state === 'permission')
    return <StatePanel title="无权裁决事实" text="该页面仅对审核人和租户管理员开放。" />;
  if (state === 'error')
    return <StatePanel title="无法加载事实" text="请检查网络或权限后刷新页面。" />;
  if (state === 'empty-scope')
    return <StatePanel title="暂无可裁决范围" text="当前租户没有可用工作区或项目。" />;

  return (
    <section className="mt-8">
      <div className="rounded-2xl border border-line bg-white p-4 shadow-panel">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className={labelClass}>
            工作区
            <select
              className={controlClass}
              disabled={!filters}
              onChange={(event) => void changeWorkspace(event.currentTarget.value)}
              value={filters?.workspaceId ?? ''}
            >
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
              disabled={!filters}
              onChange={(event) => updateFilter({ projectId: event.currentTarget.value })}
              value={filters?.projectId ?? ''}
            >
              {projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            状态
            <select
              className={controlClass}
              disabled={!filters}
              onChange={(event) => {
                const value = event.currentTarget.value;
                updateFilter({ status: value ? (value as FactStatus) : null });
              }}
              value={filters?.status ?? ''}
            >
              <option value="">全部状态</option>
              <option value="candidate">候选</option>
              <option value="verified">已确认</option>
              <option value="conflicted">冲突</option>
              <option value="retired">已退役</option>
            </select>
          </label>
          <label className={labelClass}>
            搜索
            <input
              className={controlClass}
              defaultValue={filters?.search ?? ''}
              disabled={!filters}
              key={filters?.search ?? 'empty-search'}
              onBlur={(event) => updateFilter({ search: event.currentTarget.value.trim() })}
              placeholder="主体、谓词或值"
            />
          </label>
        </div>
      </div>

      {state === 'loading' && facts.length === 0 ? (
        <ListSkeleton />
      ) : facts.length === 0 ? (
        <StatePanel title="暂无事实" text="当前筛选范围内没有待展示的事实。" />
      ) : (
        <ul className="mt-5 space-y-4" aria-label="事实列表">
          {facts.map((fact) => (
            <FactCard
              busy={busyId === fact.id}
              conflictCount={countCompetingValues(fact, facts)}
              fact={fact}
              key={fact.id}
              onMutate={mutate}
            />
          ))}
        </ul>
      )}

      <div aria-live="polite" className="mt-4 min-h-10">
        {message ? (
          <p className="rounded-control bg-brand-50 px-3 py-2 text-sm text-brand-700" role="status">
            {message}
          </p>
        ) : null}
      </div>
      {nextCursor && filters ? (
        <button
          className={secondaryButton}
          disabled={state === 'loading'}
          onClick={() =>
            void load({ ...filters, cursor: nextCursor }, true).catch(() => setState('error'))
          }
          type="button"
        >
          加载更多
        </button>
      ) : null}
    </section>
  );
}

function FactCard({
  busy,
  conflictCount,
  fact,
  onMutate,
}: {
  busy: boolean;
  conflictCount: number;
  fact: Fact;
  onMutate: (fact: Fact, decision: FactDecision) => Promise<void>;
}) {
  return (
    <li className="rounded-2xl border border-line bg-white p-5 shadow-panel sm:p-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold text-ink-950">
              {fact.subject} · {fact.predicate}
            </h2>
            <StatusBadge status={fact.status} />
            {conflictCount > 0 ? (
              <span className="rounded-full bg-red-50 px-2 py-1 text-xs font-semibold text-red-700">
                存在 {conflictCount} 个竞争值
              </span>
            ) : null}
          </div>
          <p className="mt-3 text-lg font-semibold text-brand-700">
            {fact.object_value} {fact.unit ?? ''}
          </p>
          <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-xs text-ink-500">
            <div>
              <dt className="inline">有效期：</dt>
              <dd className="inline">
                {fact.valid_from ?? '未指定'} 至 {fact.valid_to ?? '长期'}
              </dd>
            </div>
            <div>
              <dt className="inline">置信度：</dt>
              <dd className="inline">{Math.round(fact.confidence * 100)}%</dd>
            </div>
            <div>
              <dt className="inline">更新时间：</dt>
              <dd className="inline">{formatDateTime(fact.updated_at)}</dd>
            </div>
          </dl>
        </div>
        {fact.status !== 'retired' ? (
          <div className="flex shrink-0 flex-wrap gap-2">
            {fact.status !== 'verified' ? (
              <ActionButton busy={busy} label="确认" onClick={() => onMutate(fact, 'verified')} />
            ) : null}
            {fact.status !== 'conflicted' ? (
              <ActionButton
                busy={busy}
                label="标记冲突"
                onClick={() => onMutate(fact, 'conflicted')}
              />
            ) : null}
            <ActionButton busy={busy} label="退役" onClick={() => onMutate(fact, 'retired')} />
          </div>
        ) : null}
      </div>
      <div className="mt-5 border-t border-line pt-4">
        <h3 className="text-sm font-semibold text-ink-700">来源证据</h3>
        {fact.evidence?.length ? (
          <ul className="mt-3 space-y-3">
            {fact.evidence.map((evidence) => (
              <li className="rounded-control bg-surface-subtle p-3 text-sm" key={evidence.id}>
                <blockquote className="leading-6 text-ink-700">“{evidence.quote_text}”</blockquote>
                <a
                  className="mt-2 inline-flex font-semibold text-brand-700 underline focus:outline-2 focus:outline-offset-2"
                  href={`/know-03?id=${evidence.source_document_id}&chunk=${evidence.chunk_id}`}
                >
                  查看原始资料与 chunk
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-red-700">无可回溯来源，不应确认。</p>
        )}
      </div>
    </li>
  );
}

function ActionButton({
  busy,
  label,
  onClick,
}: {
  busy: boolean;
  label: string;
  onClick: () => Promise<void>;
}) {
  return (
    <button
      className={secondaryButton}
      disabled={busy}
      onClick={() => void onClick()}
      type="button"
    >
      {label}
    </button>
  );
}

function StatusBadge({ status }: { status: FactStatus }) {
  const labels: Record<FactStatus, string> = {
    candidate: '候选',
    conflicted: '冲突',
    retired: '已退役',
    verified: '已确认',
  };
  return (
    <span className="rounded-full bg-surface-subtle px-2 py-1 text-xs font-semibold text-ink-700">
      {labels[status]}
    </span>
  );
}

function StatePanel({ text, title }: { text: string; title: string }) {
  return (
    <section className="mt-6 rounded-2xl border border-line bg-white p-8 text-center shadow-panel">
      <h2 className="text-xl font-semibold text-ink-950">{title}</h2>
      <p className="mt-3 text-sm text-ink-500">{text}</p>
    </section>
  );
}

function ListSkeleton() {
  return (
    <div className="mt-5 space-y-4" aria-label="正在加载事实">
      {[0, 1].map((item) => (
        <div className="h-56 animate-pulse rounded-2xl bg-surface-subtle" key={item} />
      ))}
    </div>
  );
}

function countCompetingValues(target: Fact, facts: Fact[]) {
  return facts.filter(
    (item) =>
      item.id !== target.id &&
      item.status !== 'retired' &&
      item.subject === target.subject &&
      item.predicate === target.predicate &&
      item.object_value !== target.object_value,
  ).length;
}

function readQuery() {
  const query = new URLSearchParams(window.location.search);
  const rawStatus = query.get('status');
  return {
    projectId: query.get('project_id') ?? '',
    search: query.get('search')?.trim() ?? '',
    status: isFactStatus(rawStatus) ? rawStatus : undefined,
    workspaceId: query.get('workspace_id') ?? '',
  };
}

function writeQuery(filters: FactFilters) {
  const query = new URLSearchParams({
    project_id: filters.projectId,
    workspace_id: filters.workspaceId,
  });
  if (filters.search) query.set('search', filters.search);
  if (filters.status) query.set('status', filters.status);
  window.history.replaceState(null, '', `/know-04?${query}`);
}

function isFactStatus(value: string | null): value is FactStatus {
  return ['candidate', 'verified', 'conflicted', 'retired'].includes(value ?? '');
}

function decisionLabel(decision: FactDecision) {
  return { conflicted: '标记冲突', retired: '退役', verified: '确认' }[decision];
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function readCookie(name: string) {
  const prefix = `${encodeURIComponent(name)}=`;
  const cookie = document.cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : '';
}

const labelClass = 'text-sm font-medium text-ink-700';
const controlClass =
  'mt-2 block h-11 w-full rounded-control border border-line bg-white px-3 text-sm text-ink-950 focus:border-brand-500 focus:outline-2 focus:outline-offset-2 disabled:bg-surface-subtle';
const secondaryButton =
  'h-10 rounded-control border border-line bg-white px-4 text-sm font-semibold text-ink-700 focus:outline-2 focus:outline-offset-2 disabled:opacity-60';
