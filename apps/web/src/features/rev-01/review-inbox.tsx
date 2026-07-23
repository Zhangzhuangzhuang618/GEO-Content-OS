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

  async function startReview(item: ReviewInboxItem) {
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    setClaimingId(item.id);
    setMessage(null);
    try {
      await claimReview(
        item.id,
        item.version,
        item.risk_level ?? 'medium',
        defaultReviewDueAt(),
        csrf,
      );
      window.location.assign(`/rev-02?id=${item.id}`);
    } catch {
      setMessage('暂时无法开始审核。这条内容可能已由其他成员接手，请刷新后重试。');
    } finally {
      setClaimingId(null);
    }
  }

  if (state === 'permission')
    return <StatePanel title="无权查看审核队列" text="仅企业管理员、所有者和审核员可访问。" />;
  if (state === 'error')
    return <StatePanel title="无法加载审核队列" text="请检查筛选条件或网络后重试。" />;

  return (
    <section className="mt-8">
      <details className="rounded-2xl border border-line bg-white shadow-panel">
        <summary className="cursor-pointer px-5 py-4 text-sm font-semibold text-ink-800">
          筛选审核任务
        </summary>
        <form
          aria-label="审核队列筛选"
          className="border-t border-line p-5"
          key={JSON.stringify(filters)}
          onSubmit={applyFilters}
        >
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <SelectField
              label="处理进度"
              name="status"
              options={STATUS_OPTIONS}
              value={filters.status}
            />
            <SelectField
              label="发布平台"
              name="platform_code"
              options={PLATFORM_OPTIONS}
              value={filters.platformCode}
            />
            <SelectField
              label="处理优先级"
              name="risk_level"
              options={RISK_OPTIONS}
              value={filters.riskLevel}
            />
            <SelectField
              label="任务归属"
              name="claim_state"
              options={CLAIM_OPTIONS}
              value={filters.claimState}
            />
            <div className="flex items-end gap-3">
              <button className={primaryButton} type="submit">
                筛选
              </button>
              <button
                className={secondaryButton}
                onClick={() => {
                  setFilters({});
                  writeFilters({});
                }}
                type="button"
              >
                恢复全部
              </button>
            </div>
          </div>
        </form>
      </details>

      {message ? (
        <p aria-live="polite" className="mt-4 text-sm text-ink-700">
          {message}
        </p>
      ) : null}
      {state === 'loading' ? (
        <StatePanel title="正在加载审核队列" text="正在读取当前可处理的审核内容。" />
      ) : items.length === 0 ? (
        <StatePanel title="暂时没有待审核内容" text="新内容提交审核后会出现在这里。" />
      ) : (
        <div className="mt-5 space-y-4">
          {items.map((item) => (
            <ReviewCard
              busy={claimingId === item.id}
              item={item}
              key={item.id}
              onStart={startReview}
            />
          ))}
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

function ReviewCard({
  busy,
  item,
  onStart,
}: {
  readonly busy: boolean;
  readonly item: ReviewInboxItem;
  readonly onStart: (item: ReviewInboxItem) => Promise<void>;
}) {
  const platforms = item.platform_codes.map(platformLabel).join('、');
  return (
    <article className="rounded-2xl border border-line bg-white p-5 shadow-panel sm:p-6">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-semibold text-ink-950">{platforms}内容</h2>
            <span className="rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
              {statusLabel(item.status)}
            </span>
          </div>
          <p className="mt-2 text-sm text-ink-500">
            {formatDate(item.created_at)} 提交 · {item.variant_count} 个发布平台
          </p>
          <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-3 text-sm">
            <div>
              <dt className="text-ink-500">处理优先级</dt>
              <dd className="mt-1 font-medium text-ink-800">{riskLabel(item.risk_level)}</dd>
            </div>
            <div>
              <dt className="text-ink-500">完成时间</dt>
              <dd className="mt-1 font-medium text-ink-800">
                {item.due_at ? formatDate(item.due_at) : '开始审核后 24 小时内'}
              </dd>
            </div>
            <div>
              <dt className="text-ink-500">共同确认</dt>
              <dd className="mt-1 font-medium text-ink-800">
                {item.pending_signoff_count
                  ? `还有 ${item.pending_signoff_count} 项待确认`
                  : '无需其他负责人确认'}
              </dd>
            </div>
          </dl>
        </div>
        <div className="shrink-0 lg:text-right">
          {item.claimed_by ? (
            <Link className={primaryButton} href={`/rev-02?id=${item.id}`}>
              查看审核内容
            </Link>
          ) : (
            <button
              className={primaryButton}
              disabled={busy}
              onClick={() => void onStart(item)}
              type="button"
            >
              {busy ? '正在打开' : '开始审核'}
            </button>
          )}
          <p className="mt-2 max-w-xs text-xs leading-5 text-ink-500">
            {item.claimed_by ? '任务已分配，可继续查看和处理。' : '开始后任务会自动分配给你。'}
          </p>
        </div>
      </div>
    </article>
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
  ['low', '常规'],
  ['medium', '普通'],
  ['high', '优先'],
  ['critical', '紧急'],
] as const;
const CLAIM_OPTIONS = [
  ['mine', '我负责的'],
  ['unclaimed', '待分配'],
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
  return code ? (RISK_OPTIONS.find(([value]) => value === code)?.[1] ?? code) : '普通';
}
function defaultReviewDueAt() {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}
const controlClass =
  'mt-2 h-11 w-full rounded-control border border-line bg-white px-3 text-sm text-ink-950 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-100';
const primaryButton =
  'inline-flex h-11 items-center justify-center rounded-control bg-brand-600 px-4 text-sm font-semibold text-white disabled:opacity-50';
const secondaryButton =
  'h-11 rounded-control border border-line px-4 text-sm font-semibold text-ink-700';
