'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import { claimReview, listReviewInbox, ReviewInboxRequestError } from './review-inbox-api';
import {
  ClaimStateSchema,
  PlatformCodeSchema,
  ReviewStatusSchema,
  RiskLevelSchema,
  type ReviewFilters,
  type ReviewInboxItem,
  type RiskLevel,
} from './review-inbox.schema';

const REVIEW_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'reviewer']);

export function ReviewInbox() {
  const [filters, setFilters] = useState<ReviewFilters>(readFilters);
  const [items, setItems] = useState<ReviewInboxItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'permission'>('loading');
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async (next: ReviewFilters, signal?: AbortSignal) => {
    setState('loading');
    try {
      const tenants = await listAvailableTenants(signal);
      const role = tenants.find((tenant) => tenant.is_active)?.role_code;
      if (!role || !REVIEW_ROLES.has(role)) {
        setState('permission');
        return;
      }
      const page = await listReviewInbox(next, signal);
      if (signal?.aborted) return;
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
    const next = parseFilters(data);
    setFilters(next);
    writeFilters(next);
  }

  function changePage(cursor?: string) {
    const next = { ...filters, ...(cursor ? { cursor } : {}) };
    if (!cursor) delete next.cursor;
    setFilters(next);
    writeFilters(next);
  }

  async function claim(item: ReviewInboxItem, riskLevel: RiskLevel, dueAt: string) {
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    const parsedDueAt = new Date(dueAt);
    if (!Number.isFinite(parsedDueAt.getTime()) || parsedDueAt.getTime() <= Date.now()) {
      setMessage('截止时间必须晚于当前时间。');
      return;
    }
    setClaimingId(item.id);
    setMessage(null);
    try {
      await claimReview(item.id, item.version, riskLevel, parsedDueAt.toISOString(), csrf);
      setMessage('审核任务已领取。');
      await load(filters);
    } catch {
      setMessage('领取失败；任务可能已被他人领取或版本已更新，请刷新后重试。');
    } finally {
      setClaimingId(null);
    }
  }

  if (state === 'permission')
    return <StatePanel title="无权查看审核队列" text="仅租户管理员、所有者和审核员可访问。" />;
  if (state === 'error')
    return <StatePanel title="无法加载审核队列" text="请检查筛选条件或网络后重试。" />;

  return (
    <section className="mt-8">
      <form
        aria-label="审核队列筛选"
        className="rounded-2xl border border-line bg-white p-4 shadow-panel"
        key={JSON.stringify(filters)}
        onSubmit={applyFilters}
      >
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <TextField defaultValue={filters.workspaceId} label="工作区 UUID" name="workspace_id" />
          <TextField defaultValue={filters.projectId} label="项目 UUID" name="project_id" />
          <TextField defaultValue={filters.createdBy} label="提交人 UUID" name="created_by" />
          <SelectField label="状态" name="status" options={STATUS_OPTIONS} value={filters.status} />
          <SelectField
            label="平台"
            name="platform_code"
            options={PLATFORM_OPTIONS}
            value={filters.platformCode}
          />
          <SelectField
            label="风险"
            name="risk_level"
            options={RISK_OPTIONS}
            value={filters.riskLevel}
          />
          <SelectField
            label="领取状态"
            name="claim_state"
            options={CLAIM_OPTIONS}
            value={filters.claimState}
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

      {message ? (
        <p aria-live="polite" className="mt-4 text-sm text-ink-700">
          {message}
        </p>
      ) : null}
      {state === 'loading' ? (
        <StatePanel title="正在加载审核队列" text="正在读取当前权限范围内的冻结快照。" />
      ) : items.length === 0 ? (
        <StatePanel title="暂无审核任务" text="当前筛选和分页下没有可访问的审核快照。" />
      ) : (
        <div className="mt-5 overflow-x-auto rounded-2xl border border-line bg-white shadow-panel">
          <table className="w-full min-w-[1320px] text-left text-sm">
            <thead className="bg-surface-subtle text-ink-500">
              <tr>
                <th className="p-4">快照</th>
                <th className="p-4">风险 / 截止</th>
                <th className="p-4">提交人</th>
                <th className="p-4">平台</th>
                <th className="p-4">状态</th>
                <th className="p-4">加签</th>
                <th className="p-4">领取</th>
                <th className="p-4">动作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <ReviewRow
                  busy={claimingId === item.id}
                  item={item}
                  key={item.id}
                  onClaim={claim}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <nav aria-label="审核队列分页" className="mt-5 flex gap-3">
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

function ReviewRow({
  busy,
  item,
  onClaim,
}: {
  readonly busy: boolean;
  readonly item: ReviewInboxItem;
  readonly onClaim: (item: ReviewInboxItem, risk: RiskLevel, dueAt: string) => Promise<void>;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const risk = RiskLevelSchema.safeParse(data.get('risk_level'));
    if (risk.success) void onClaim(item, risk.data, String(data.get('due_at') ?? ''));
  }
  return (
    <tr className="border-t border-line">
      <td className="p-4">
        <span className="font-mono">{shortId(item.id)}</span>
        <p className="mt-1 text-xs text-ink-500">工作区 {shortId(item.workspace_id)}</p>
      </td>
      <td className="p-4">
        <span className={riskClass(item.risk_level)}>{riskLabel(item.risk_level)}</span>
        <p className="mt-1 text-xs text-ink-500">
          {item.due_at ? formatDate(item.due_at) : '未设置截止时间'}
        </p>
      </td>
      <td className="p-4 font-mono text-xs">{item.created_by}</td>
      <td className="p-4">{item.platform_codes.map(platformLabel).join('、')}</td>
      <td className="p-4">{statusLabel(item.status)}</td>
      <td className="p-4">待处理 {item.pending_signoff_count}</td>
      <td className="p-4">
        {item.claimed_by ? (
          <>
            <span>已领取</span>
            <p className="mt-1 font-mono text-xs text-ink-500">{shortId(item.claimed_by)}</p>
          </>
        ) : (
          <form className="grid min-w-[220px] gap-2" onSubmit={submit}>
            <select
              aria-label={`风险 ${shortId(item.id)}`}
              className={compactControl}
              defaultValue="medium"
              name="risk_level"
            >
              {RISK_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <input
              aria-label={`截止时间 ${shortId(item.id)}`}
              className={compactControl}
              defaultValue={defaultDueAt()}
              min={minimumDueAt()}
              name="due_at"
              type="datetime-local"
            />
            <button className={primaryButton} disabled={busy} type="submit">
              {busy ? '领取中' : '领取'}
            </button>
          </form>
        )}
      </td>
      <td className="p-4">
        <Link className="font-medium text-brand-700" href={`/rev-02?id=${item.id}`}>
          进入快照
        </Link>
      </td>
    </tr>
  );
}

const PLATFORM_OPTIONS = [
  ['official_site', '官网'],
  ['baijiahao', '百家号'],
  ['toutiao', '头条号'],
  ['zhihu', '知乎'],
  ['xiaohongshu', '小红书'],
  ['wechat_mp', '微信公众号'],
  ['douyin', '抖音'],
] as const;
const STATUS_OPTIONS = [
  ['in_review', '审核中'],
  ['approved', '已通过'],
  ['rejected', '已退回'],
  ['superseded', '已替代'],
] as const;
const RISK_OPTIONS = [
  ['low', '低'],
  ['medium', '中'],
  ['high', '高'],
  ['critical', '严重'],
] as const;
const CLAIM_OPTIONS = [
  ['mine', '我领取的'],
  ['unclaimed', '未领取'],
] as const;

function parseFilters(data: FormData): ReviewFilters {
  const platform = PlatformCodeSchema.safeParse(data.get('platform_code'));
  const status = ReviewStatusSchema.safeParse(data.get('status'));
  const risk = RiskLevelSchema.safeParse(data.get('risk_level'));
  const claimState = ClaimStateSchema.safeParse(data.get('claim_state'));
  const value = (name: string) => String(data.get(name) ?? '').trim();
  return {
    ...(claimState.success ? { claimState: claimState.data } : {}),
    ...(value('created_by') ? { createdBy: value('created_by') } : {}),
    ...(platform.success ? { platformCode: platform.data } : {}),
    ...(value('project_id') ? { projectId: value('project_id') } : {}),
    ...(risk.success ? { riskLevel: risk.data } : {}),
    ...(status.success ? { status: status.data } : {}),
    ...(value('workspace_id') ? { workspaceId: value('workspace_id') } : {}),
  };
}
function readFilters(): ReviewFilters {
  if (typeof window === 'undefined') return {};
  const query = new URLSearchParams(window.location.search);
  const data = new FormData();
  for (const key of [
    'claim_state',
    'created_by',
    'platform_code',
    'project_id',
    'risk_level',
    'status',
    'workspace_id',
  ])
    data.set(key, query.get(key) ?? '');
  const filters = parseFilters(data);
  const cursor = query.get('cursor');
  return cursor ? { ...filters, cursor } : filters;
}
function writeFilters(filters: ReviewFilters) {
  const query = new URLSearchParams();
  const values: readonly [string, string | undefined][] = [
    ['claim_state', filters.claimState],
    ['created_by', filters.createdBy],
    ['cursor', filters.cursor],
    ['platform_code', filters.platformCode],
    ['project_id', filters.projectId],
    ['risk_level', filters.riskLevel],
    ['status', filters.status],
    ['workspace_id', filters.workspaceId],
  ];
  values.forEach(([key, value]) => {
    if (value) query.set(key, value);
  });
  window.history.replaceState(null, '', query.size ? `/rev-01?${query}` : '/rev-01');
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
      <input className={controlClass} defaultValue={defaultValue ?? ''} name={name} />
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
function isAccessError(error: unknown) {
  return error instanceof ReviewInboxRequestError && [401, 403, 404].includes(error.status);
}
function readCookie(name: string) {
  const entry = document.cookie.split('; ').find((value) => value.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
}
function shortId(id: string) {
  return id.slice(0, 8);
}
function formatDate(value: string) {
  return new Date(value).toLocaleString('zh-CN');
}
function platformLabel(code: string) {
  return PLATFORM_OPTIONS.find(([value]) => value === code)?.[1] ?? code;
}
function statusLabel(code: string) {
  return STATUS_OPTIONS.find(([value]) => value === code)?.[1] ?? code;
}
function riskLabel(code: string | null) {
  return code ? (RISK_OPTIONS.find(([value]) => value === code)?.[1] ?? code) : '未分级';
}
function riskClass(code: string | null) {
  return `inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${code === 'critical' ? 'bg-red-100 text-red-800' : code === 'high' ? 'bg-amber-100 text-amber-900' : code ? 'bg-brand-50 text-brand-700' : 'bg-slate-100 text-ink-500'}`;
}
function minimumDueAt() {
  return localDateTime(new Date(Date.now() + 60_000));
}
function defaultDueAt() {
  return localDateTime(new Date(Date.now() + 24 * 60 * 60 * 1000));
}
function localDateTime(value: Date) {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
const controlClass =
  'mt-2 h-11 w-full rounded-control border border-line bg-white px-3 text-sm text-ink-950 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-100';
const compactControl = 'h-9 rounded-control border border-line bg-white px-2 text-xs text-ink-950';
const primaryButton =
  'inline-flex h-11 items-center justify-center rounded-control bg-brand-600 px-4 text-sm font-semibold text-white disabled:opacity-50';
const secondaryButton =
  'h-11 rounded-control border border-line px-4 text-sm font-semibold text-ink-700';
