'use client';

import {
  useEffect,
  useState,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';

import { TechnicalDetails } from '../human-readable';
import { AuditLogRequestError, listAuditEvents } from './audit-log-api';
import type { AuditEvent, AuditFilters } from './audit-log.schema';

const EMPTY_FILTERS: AuditFilters = {
  action: '',
  actorId: '',
  from: '',
  requestId: '',
  resourceId: '',
  resourceType: '',
  to: '',
};

export function AuditLog() {
  const [filters, setFilters] = useState<AuditFilters>(readFilters);
  const [items, setItems] = useState<readonly AuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'permission'>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void load(filters, undefined, false, controller.signal);
    return () => controller.abort();
  }, []);

  async function load(
    nextFilters: AuditFilters,
    cursor?: string,
    append = false,
    signal?: AbortSignal,
  ) {
    if (append) setLoadingMore(true);
    else setState('loading');
    try {
      const page = await listAuditEvents(nextFilters, cursor, signal);
      if (signal?.aborted) return;
      setItems((current) => (append ? [...current, ...page.items] : page.items));
      setNextCursor(page.next_cursor);
      setState('ready');
    } catch (error) {
      if (signal?.aborted) return;
      setState(
        error instanceof AuditLogRequestError && error.status === 403 ? 'permission' : 'error',
      );
    } finally {
      if (!signal?.aborted) setLoadingMore(false);
    }
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = filtersFromForm(new FormData(event.currentTarget));
    setFilters(next);
    writeFilters(next);
    setMessage(null);
    void load(next);
  }

  function resetFilters() {
    setFilters(EMPTY_FILTERS);
    writeFilters(EMPTY_FILTERS);
    setMessage(null);
    void load(EMPTY_FILTERS);
  }

  function exportCsv() {
    if (items.length === 0) {
      setMessage('当前筛选结果没有可导出的审计事件。');
      return;
    }
    const rows = items.map((item) => [
      item.id,
      item.actor_name ?? '系统',
      item.actor_id ?? '',
      item.action,
      item.resource_type,
      item.resource_id ?? '',
      jsonText(item.before),
      jsonText(item.after),
      item.request_id,
      item.ip ?? '',
      item.created_at,
    ]);
    downloadCsv(
      `audit-events-${new Date().toISOString().slice(0, 10)}.csv`,
      [
        'id',
        'actor_name',
        'actor_id',
        'action',
        'resource_type',
        'resource_id',
        'before',
        'after',
        'request_id',
        'ip',
        'created_at',
      ],
      rows,
    );
    setMessage(`已导出当前加载的 ${rows.length} 条审计事件。`);
  }

  if (state === 'loading' && items.length === 0)
    return <StatePanel title="正在加载操作记录" text="正在读取当前企业的重要操作记录。" />;
  if (state === 'permission')
    return <StatePanel title="无权查看操作记录" text="仅企业所有者可查看和导出。" />;
  if (state === 'error')
    return <StatePanel title="无法加载审计日志" text="请检查筛选条件、网络、会话或服务状态。" />;

  return (
    <section className="mt-8 space-y-5">
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
        重要操作记录不可编辑或删除，用于追踪谁在什么时间进行了哪些变更。
      </div>
      <FilterPanel
        filters={filters}
        onExport={exportCsv}
        onReset={resetFilters}
        onSubmit={applyFilters}
      />
      <div aria-live="polite" className="min-h-6 text-sm text-ink-700" role="status">
        {message}
      </div>
      {items.length === 0 ? (
        <StatePanel title="暂无操作记录" text="当前企业和筛选范围内没有匹配记录。" />
      ) : (
        <AuditResults items={items} />
      )}
      {nextCursor ? (
        <button
          className={secondaryButton}
          disabled={loadingMore}
          onClick={() => void load(filters, nextCursor, true)}
          type="button"
        >
          {loadingMore ? '正在加载…' : '加载更多'}
        </button>
      ) : null}
    </section>
  );
}

function FilterPanel({
  filters,
  onExport,
  onReset,
  onSubmit,
}: {
  readonly filters: AuditFilters;
  readonly onExport: () => void;
  readonly onReset: () => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form
      aria-label="审计日志筛选"
      className="rounded-2xl border border-line bg-white p-5 shadow-panel"
      key={JSON.stringify(filters)}
      onSubmit={onSubmit}
    >
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Input defaultValue={filters.action} label="操作类型" name="action" />
        <Input defaultValue={filters.resourceType} label="对象类型" name="resource_type" />
        <Input defaultValue={filters.from} label="开始日期" name="from" type="date" />
        <Input defaultValue={filters.to} label="结束日期" name="to" type="date" />
      </div>
      <div className="mt-4">
        <details className="text-sm text-ink-600">
          <summary className="cursor-pointer font-medium">按技术编号精确查找</summary>
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            <Input defaultValue={filters.actorId} label="操作人编号" name="actor_id" />
            <Input defaultValue={filters.resourceId} label="对象编号" name="resource_id" />
            <Input defaultValue={filters.requestId} label="请求编号" name="request_id" />
          </div>
        </details>
      </div>
      <div className="mt-5 flex flex-wrap gap-3">
        <button className={primaryButton} type="submit">
          应用筛选
        </button>
        <button className={secondaryButton} onClick={onReset} type="button">
          重置
        </button>
        <button className={secondaryButton} onClick={onExport} type="button">
          导出当前结果 CSV
        </button>
      </div>
    </form>
  );
}

function AuditResults({ items }: { readonly items: readonly AuditEvent[] }) {
  return (
    <>
      <div className="space-y-4 md:hidden">
        {items.map((item) => (
          <AuditCard item={item} key={item.id} />
        ))}
      </div>
      <div className="hidden overflow-x-auto rounded-2xl border border-line bg-white shadow-panel md:block">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-surface-subtle text-xs tracking-wide text-ink-500 uppercase">
            <tr>
              <Header>时间 / 操作人</Header>
              <Header>操作 / 对象</Header>
              <Header>变更内容</Header>
              <Header>更多</Header>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {items.map((item) => (
              <tr className="align-top" key={item.id}>
                <Cell>
                  <p>{formatTime(item.created_at)}</p>
                  <p className="mt-1 font-medium text-ink-950">{item.actor_name ?? '系统'}</p>
                </Cell>
                <Cell>
                  <p className="font-medium text-ink-950">{actionLabel(item.action)}</p>
                  <p className="mt-1">{resourceLabel(item.resource_type)}</p>
                </Cell>
                <Cell>
                  <JsonDiff after={item.after} before={item.before} />
                </Cell>
                <Cell>
                  <TechnicalDetails>
                    <p>操作人：{item.actor_id ?? 'system'}</p>
                    <p>对象：{item.resource_id ?? '—'}</p>
                    <p>请求：{item.request_id}</p>
                    <p>IP：{item.ip ?? '—'}</p>
                  </TechnicalDetails>
                </Cell>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function AuditCard({ item }: { readonly item: AuditEvent }) {
  return (
    <article className="rounded-2xl border border-line bg-white p-4 shadow-panel">
      <p className="text-xs text-ink-500">{formatTime(item.created_at)}</p>
      <h2 className="mt-2 font-semibold text-ink-950">{actionLabel(item.action)}</h2>
      <p className="mt-1 text-sm text-ink-700">
        {item.actor_name ?? '系统'} · {resourceLabel(item.resource_type)}
      </p>
      <JsonDiff after={item.after} before={item.before} />
      <TechnicalDetails>
        <p>操作人：{item.actor_id ?? 'system'}</p>
        <p>对象：{item.resource_id ?? '—'}</p>
        <p>请求：{item.request_id}</p>
        <p>IP：{item.ip ?? '—'}</p>
      </TechnicalDetails>
    </article>
  );
}

function JsonDiff({
  after,
  before,
}: {
  readonly after: AuditEvent['after'];
  readonly before: AuditEvent['before'];
}) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer font-medium text-brand-700">查看变更详情</summary>
      <div className="mt-2 space-y-2">
        <details>
          <summary className="cursor-pointer font-medium">变更前</summary>
          <pre className="mt-1 max-h-40 max-w-md overflow-auto whitespace-pre-wrap rounded-control bg-surface-subtle p-2 text-xs">
            {jsonText(before)}
          </pre>
        </details>
        <details>
          <summary className="cursor-pointer font-medium">变更后</summary>
          <pre className="mt-1 max-h-40 max-w-md overflow-auto whitespace-pre-wrap rounded-control bg-surface-subtle p-2 text-xs">
            {jsonText(after)}
          </pre>
        </details>
      </div>
    </details>
  );
}

function Input({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { readonly label: string }) {
  return (
    <label className="grid gap-1.5 text-sm font-medium text-ink-700">
      {label}
      <input className={controlClass} {...props} />
    </label>
  );
}

function Header({ children }: { readonly children: ReactNode }) {
  return <th className="px-4 py-3 font-semibold">{children}</th>;
}

function Cell({ children }: { readonly children: ReactNode }) {
  return <td className="max-w-md px-4 py-4 text-ink-700">{children}</td>;
}

function StatePanel({ text, title }: { readonly text: string; readonly title: string }) {
  return (
    <section className="mt-8 rounded-2xl border border-line bg-white p-8 text-center shadow-panel">
      <h2 className="text-xl font-semibold text-ink-950">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-ink-500">{text}</p>
    </section>
  );
}

function readFilters(): AuditFilters {
  if (typeof window === 'undefined') return EMPTY_FILTERS;
  const query = new URLSearchParams(window.location.search);
  return {
    action: query.get('action') ?? '',
    actorId: query.get('actor_id') ?? '',
    from: query.get('from') ?? '',
    requestId: query.get('request_id') ?? '',
    resourceId: query.get('resource_id') ?? '',
    resourceType: query.get('resource_type') ?? '',
    to: query.get('to') ?? '',
  };
}

function filtersFromForm(form: FormData): AuditFilters {
  return {
    action: text(form, 'action'),
    actorId: text(form, 'actor_id'),
    from: text(form, 'from'),
    requestId: text(form, 'request_id'),
    resourceId: text(form, 'resource_id'),
    resourceType: text(form, 'resource_type'),
    to: text(form, 'to'),
  };
}

function writeFilters(filters: AuditFilters) {
  const query = new URLSearchParams();
  for (const [key, value] of [
    ['actor_id', filters.actorId],
    ['action', filters.action],
    ['resource_type', filters.resourceType],
    ['resource_id', filters.resourceId],
    ['request_id', filters.requestId],
    ['from', filters.from],
    ['to', filters.to],
  ] as const)
    if (value) query.set(key, value);
  window.history.replaceState(null, '', `/set-04${query.size ? `?${query}` : ''}`);
}

function text(form: FormData, key: string): string {
  return String(form.get(key) ?? '').trim();
}

function jsonText(value: AuditEvent['before']): string {
  return value === null ? '—' : JSON.stringify(value, null, 2);
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(value));
}

function actionLabel(value: string): string {
  const labels: Readonly<Record<string, string>> = {
    create: '创建',
    update: '修改',
    delete: '删除',
    publish: '发布',
    approve: '通过审核',
    reject: '退回修改',
    login: '登录',
  };
  if (labels[value]) return labels[value];
  const [resource, action] = value.split('.');
  const verbs: Readonly<Record<string, string>> = {
    created: '创建',
    updated: '更新',
    deleted: '删除',
    published: '发布',
    approved: '通过审核',
    rejected: '退回修改',
  };
  if (resource && action && verbs[action]) return `${verbs[action]}${resourceLabel(resource)}`;
  return value.replaceAll('_', ' ');
}

function resourceLabel(value: string): string {
  return (
    {
      content_package: '内容任务',
      content_variant: '平台内容',
      workspace: '工作区',
      project: '项目',
      source_document: '资料',
      publish_job: '发布任务',
      user: '用户',
    }[value] ?? value.replaceAll('_', ' ')
  );
}

function downloadCsv(name: string, headers: readonly string[], rows: readonly unknown[][]) {
  const csv = [headers, ...rows]
    .map((row) => row.map((value) => csvCell(String(value ?? ''))).join(','))
    .join('\r\n');
  const href = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(href);
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

const controlClass =
  'min-h-11 rounded-control border border-line bg-white px-3 py-2 text-sm text-ink-950 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';
const primaryButton =
  'min-h-11 rounded-control bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-300 disabled:opacity-60';
const secondaryButton =
  'min-h-11 rounded-control border border-line bg-white px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-200 disabled:opacity-60';
