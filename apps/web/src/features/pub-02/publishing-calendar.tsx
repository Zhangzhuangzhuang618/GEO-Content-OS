'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import { listPlatformAccounts } from '../pub-01/platform-account-api';
import {
  PlatformCodeSchema,
  type PlatformAccount,
  type PlatformCode,
} from '../pub-01/platform-account.schema';
import { resolvePublishingUrl } from '../pub-01/platform-publishing-url';
import { listWorkspaces } from '../set-02/workspace-settings-api';
import type { Workspace } from '../set-02/workspace-settings.schema';
import {
  cancelPublishJob,
  createPublishJob,
  getSchedulableVariant,
  listApprovedContent,
  listPublishJobs,
  PublishingCalendarRequestError,
  reschedulePublishJob,
} from './publishing-calendar-api';
import {
  PublishJobStatusSchema,
  type ApprovedContent,
  type PublishJob,
  type PublishingCalendarFilters,
} from './publishing-calendar.schema';

const PUBLISH_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'publisher']);

export function PublishingCalendar() {
  const [filters, setFilters] = useState<PublishingCalendarFilters>(readFilters);
  const [jobs, setJobs] = useState<readonly PublishJob[]>([]);
  const [approvedContent, setApprovedContent] = useState<readonly ApprovedContent[]>([]);
  const [accounts, setAccounts] = useState<readonly PlatformAccount[]>([]);
  const [workspaces, setWorkspaces] = useState<readonly Workspace[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'permission'>('loading');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [selectedVariantId, setSelectedVariantId] = useState(readSelectedVariantId);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);

  const load = useCallback(async (next: PublishingCalendarFilters, signal?: AbortSignal) => {
    setState('loading');
    try {
      const tenants = await listAvailableTenants(signal);
      const role = tenants.find((tenant) => tenant.is_active)?.role_code;
      if (!role || !PUBLISH_ROLES.has(role)) {
        setState('permission');
        return;
      }
      const [jobItems, approvedItems, accountItems, workspaceItems] = await Promise.all([
        listPublishJobs(next, signal),
        listApprovedContent(next, signal),
        listPlatformAccounts({}, signal),
        listWorkspaces(signal),
      ]);
      if (signal?.aborted) return;
      setJobs(jobItems);
      setApprovedContent(approvedItems);
      setAccounts(accountItems);
      setWorkspaces(workspaceItems.filter(({ status }) => status === 'active'));
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
    const next = parseFilters(new FormData(event.currentTarget));
    setFilters(next);
    writeFilters(next, selectedVariantId);
  }

  function selectContent(variantId: string) {
    setSelectedVariantId(variantId);
    setSelectedAccountId(null);
    setFormError(null);
    writeFilters(filters, variantId);
    document.querySelector('[aria-label="创建发布排期"]')?.scrollIntoView({ behavior: 'smooth' });
  }

  async function schedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const data = new FormData(form, submitter);
    const intent = data.get('intent') === 'now' ? 'now' : 'schedule';
    const variantId = String(data.get('variant_id') ?? '').trim();
    const accountId = String(data.get('account_id') ?? '').trim();
    const scheduledAt =
      intent === 'now' ? new Date().toISOString() : toIso(data.get('scheduled_at'));
    if (!variantId || !accountId || !scheduledAt) {
      setFormError('请选择要发布的内容、平台账号和排期时间。');
      return;
    }
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setFormError('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    setScheduling(true);
    setFormError(null);
    setMessage(null);
    try {
      const variant = await getSchedulableVariant(variantId);
      const account = accounts.find(({ id }) => id === accountId);
      if (variant.status !== 'approved') {
        setFormError('这份内容尚未审核通过，暂时不能发布。');
        return;
      }
      if (
        !account ||
        account.status !== 'active' ||
        account.platform_code !== variant.platform_code
      ) {
        setFormError('请选择与内容平台一致且授权有效的账号。');
        return;
      }
      await createPublishJob(accountId, variantId, scheduledAt, csrf);
      form.reset();
      setSelectedVariantId(null);
      setSelectedAccountId(null);
      writeFilters(filters, null);
      setMessage(intent === 'now' ? '立即发布任务已创建。' : '发布排期已创建。');
      await load(filters);
    } catch {
      setFormError('创建发布任务失败，请确认内容已审核通过、账号授权有效且你有发布权限。');
    } finally {
      setScheduling(false);
    }
  }

  async function runJobAction(job: PublishJob, action: 'cancel' | 'reschedule' | 'now') {
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    let scheduledAt: string | null = null;
    if (action === 'reschedule') {
      const value = window.prompt('请输入新的排期时间。', toLocalDateTime(job.scheduled_at));
      if (value === null) return;
      scheduledAt = toIso(value);
      if (!scheduledAt) {
        setMessage('改期失败：请输入有效时间。');
        return;
      }
    }
    if (action === 'now') scheduledAt = new Date().toISOString();
    const reason = action === 'cancel' ? (window.prompt('请输入取消原因。')?.trim() ?? '') : '';
    if (action === 'cancel' && !reason) return;

    setBusyId(job.id);
    setMessage(null);
    try {
      if (action === 'cancel') await cancelPublishJob(job, reason, csrf);
      if (scheduledAt) await reschedulePublishJob(job, scheduledAt, csrf);
      setMessage(
        action === 'cancel'
          ? '发布任务已取消。'
          : action === 'reschedule'
            ? '发布任务已改期。'
            : '任务已调整为立即发布。',
      );
      await load(filters);
    } catch {
      setMessage('操作失败；任务版本或状态可能已变化，请刷新后重试。');
    } finally {
      setBusyId(null);
    }
  }

  if (state === 'permission') {
    return <StatePanel title="无权查看发布日历" text="仅发布人、企业管理员和所有者可访问。" />;
  }
  if (state === 'error') {
    return <StatePanel title="无法加载发布日历" text="请检查筛选条件、网络或服务状态。" />;
  }

  const activeAccounts = accounts.filter(({ status }) => status === 'active');
  const selectedContent = approvedContent.find(({ variant }) => variant.id === selectedVariantId);
  const matchingAccounts = selectedContent
    ? activeAccounts.filter(
        ({ platform_code }) => platform_code === selectedContent.variant.platform_code,
      )
    : activeAccounts;
  const selectedAccount = matchingAccounts.find(({ id }) => id === selectedAccountId);
  const selectedPublishingUrl = selectedAccount ? resolvePublishingUrl(selectedAccount) : null;
  return (
    <section className="mt-8">
      <form
        aria-label="发布日历筛选"
        className="rounded-2xl border border-line bg-white p-4 shadow-panel"
        key={JSON.stringify(filters)}
        onSubmit={applyFilters}
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <SelectField
            label="平台"
            name="platform_code"
            options={PLATFORM_OPTIONS}
            value={filters.platformCode}
          />
          <label className={labelClass}>
            平台账号
            <select
              className={controlClass}
              defaultValue={filters.accountId ?? ''}
              name="account_id"
            >
              <option value="">全部账号</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {platformLabel(account.platform_code)} · {account.display_name}
                </option>
              ))}
            </select>
          </label>
          <SelectField
            label="任务状态"
            name="status"
            options={STATUS_OPTIONS}
            value={filters.status}
          />
          <label className={labelClass}>
            工作区
            <select
              className={controlClass}
              defaultValue={filters.workspaceId ?? ''}
              name="workspace_id"
            >
              <option value="">全部工作区</option>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>
          <DateField label="开始时间" name="from" value={filters.from} />
          <DateField label="结束时间" name="to" value={filters.to} />
        </div>
        <div className="mt-4 flex gap-3">
          <button className={secondaryButton} type="submit">
            应用筛选
          </button>
          <button
            className={secondaryButton}
            onClick={() => {
              setFilters({});
              writeFilters({}, selectedVariantId);
            }}
            type="button"
          >
            清空
          </button>
        </div>
      </form>

      <section className="mt-5 rounded-2xl border border-line bg-white p-5 shadow-panel sm:p-7">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-ink-950">待发布内容</h2>
            <p className="mt-2 text-sm text-ink-500">
              已审核通过、尚未创建发布任务的内容会自动出现在这里。
            </p>
          </div>
          <span className="text-sm text-ink-500">共 {approvedContent.length} 篇</span>
        </div>
        {approvedContent.length === 0 ? (
          <div className="mt-5 rounded-xl bg-surface-subtle p-5 text-sm text-ink-600">
            当前没有待发布内容。普通平台审核通过后会进入这里；已开启官网自动发布的项目会在机器质检通过后直接创建发布任务。
          </div>
        ) : (
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="bg-surface-subtle text-ink-500">
                <tr>
                  <th className="p-4">文章</th>
                  <th className="p-4">平台</th>
                  <th className="p-4">通过时间</th>
                  <th className="p-4">操作</th>
                </tr>
              </thead>
              <tbody>
                {approvedContent.map((item) => (
                  <tr className="border-t border-line" key={item.variant.id}>
                    <td className="p-4 font-medium text-ink-950">{item.title}</td>
                    <td className="p-4">{platformLabel(item.variant.platform_code)}</td>
                    <td className="p-4">{formatDate(item.updatedAt)}</td>
                    <td className="p-4">
                      <div className="flex flex-wrap gap-2">
                        <button
                          className={primarySmallButton}
                          onClick={() => selectContent(item.variant.id)}
                          type="button"
                        >
                          {selectedVariantId === item.variant.id ? '已选择' : '安排发布'}
                        </button>
                        <Link className={smallButton} href={`/cont-05?id=${item.variant.id}`}>
                          查看内容
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <form
        aria-label="创建发布排期"
        className="mt-5 rounded-2xl border border-line bg-white p-5 shadow-panel sm:p-7"
        noValidate
        onSubmit={(event) => void schedule(event)}
      >
        <h2 className="text-xl font-semibold text-ink-950">创建发布任务</h2>
        <p className="mt-2 text-sm text-ink-500">
          从审核通过的内容进入此页，选择发布账号和时间即可。
        </p>
        {selectedVariantId ? (
          <div className="mt-4 rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800">
            已选择：
            <strong className="ml-1">
              {selectedContent
                ? `${selectedContent.title}（${platformLabel(selectedContent.variant.platform_code)}）`
                : '一份审核通过的内容'}
            </strong>
          </div>
        ) : (
          <div className="mt-4 rounded-xl bg-amber-50 p-4 text-sm text-amber-900">
            还没有选择内容。请先到内容详情中选择已审核通过的平台内容，再点击“安排发布”。
            <Link className="ml-2 font-semibold text-brand-700" href="/cont-03">
              前往内容列表
            </Link>
          </div>
        )}
        {matchingAccounts.length === 0 ? (
          <div className="mt-4 rounded-xl bg-amber-50 p-4 text-sm text-amber-900">
            {selectedContent
              ? `还没有可用于${platformLabel(selectedContent.variant.platform_code)}的账号。`
              : '当前没有可用的平台账号。'}
            <Link className="ml-2 font-semibold text-brand-700" href="/pub-01">
              配置平台账号
            </Link>
          </div>
        ) : null}
        <input name="variant_id" type="hidden" value={selectedVariantId ?? ''} />
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <label className={labelClass}>
            平台账号
            <select
              className={controlClass}
              name="account_id"
              onChange={(event) => setSelectedAccountId(event.currentTarget.value || null)}
              value={selectedAccountId ?? ''}
            >
              <option disabled value="">
                请选择账号
              </option>
              {matchingAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {platformLabel(account.platform_code)} · {account.display_name}
                </option>
              ))}
            </select>
            <Link className="mt-2 inline-flex text-sm font-semibold text-brand-700" href="/pub-01">
              管理平台账号
            </Link>
            {selectedPublishingUrl ? (
              <a
                className="ml-4 mt-2 inline-flex text-sm font-semibold text-brand-700"
                href={selectedPublishingUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                在新标签页打开发布后台
              </a>
            ) : null}
          </label>
          <label className={labelClass}>
            排期时间
            <input className={controlClass} name="scheduled_at" type="datetime-local" />
          </label>
        </div>
        <div aria-live="polite" className="mt-4 min-h-6 text-sm text-red-700">
          {formError}
        </div>
        <div className="mt-3 flex flex-wrap gap-3">
          <button
            className={primaryButton}
            disabled={scheduling || !selectedVariantId || matchingAccounts.length === 0}
            name="intent"
            type="submit"
            value="schedule"
          >
            {scheduling ? '正在创建…' : '排期'}
          </button>
          <button
            className={secondaryButton}
            disabled={scheduling || !selectedVariantId || matchingAccounts.length === 0}
            name="intent"
            type="submit"
            value="now"
          >
            立即发布
          </button>
        </div>
      </form>

      <div aria-live="polite" className="mt-4 min-h-6 text-sm text-ink-700">
        {message}
      </div>

      <div className="mt-3">
        <h2 className="text-xl font-semibold text-ink-950">发布任务</h2>
        <p className="mt-2 text-sm text-ink-500">查看已排期、发布中、已完成或失败的任务。</p>
      </div>

      {state === 'loading' ? (
        <StatePanel title="正在加载发布日历" text="正在读取当前权限范围内的任务和账号。" />
      ) : jobs.length === 0 ? (
        <StatePanel title="暂无发布任务" text="当前筛选下没有排期，可从审核通过的内容安排发布。" />
      ) : (
        <div className="mt-5 overflow-x-auto rounded-2xl border border-line bg-white shadow-panel">
          <table className="w-full min-w-[1040px] text-left text-sm">
            <thead className="bg-surface-subtle text-ink-500">
              <tr>
                <th className="p-4">日期</th>
                <th className="p-4">平台</th>
                <th className="p-4">账号</th>
                <th className="p-4">发布内容</th>
                <th className="p-4">状态</th>
                <th className="p-4">动作</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <JobRow
                  account={accounts.find(({ id }) => id === job.account_id)}
                  busy={busyId === job.id}
                  job={job}
                  key={job.id}
                  onAction={runJobAction}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function JobRow({
  account,
  busy,
  job,
  onAction,
}: {
  readonly account?: PlatformAccount | undefined;
  readonly busy: boolean;
  readonly job: PublishJob;
  readonly onAction: (job: PublishJob, action: 'cancel' | 'reschedule' | 'now') => Promise<void>;
}) {
  const scheduled = job.status === 'scheduled';
  const cancellable = scheduled || job.status === 'publishing';
  const publishingUrl = account ? resolvePublishingUrl(account) : null;
  return (
    <tr className="border-t border-line">
      <td className="p-4">{formatDate(job.scheduled_at)}</td>
      <td className="p-4">{account ? platformLabel(account.platform_code) : '账号不可用'}</td>
      <td className="p-4">{account?.display_name ?? '账号不可用'}</td>
      <td className="p-4">{originLabel(job.origin)}</td>
      <td className="p-4">
        <StatusBadge status={job.status} />
      </td>
      <td className="p-4">
        <div className="flex flex-wrap gap-2">
          {publishingUrl ? (
            <a
              className={smallButton}
              href={publishingUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              发布后台
            </a>
          ) : null}
          <Link className={smallButton} href={`/pub-03?id=${job.id}`}>
            查看详情
          </Link>
          {scheduled ? (
            <button
              className={smallButton}
              disabled={busy}
              onClick={() => void onAction(job, 'reschedule')}
              type="button"
            >
              改期
            </button>
          ) : null}
          {scheduled ? (
            <button
              className={smallButton}
              disabled={busy}
              onClick={() => void onAction(job, 'now')}
              type="button"
            >
              立即发布
            </button>
          ) : null}
          {cancellable ? (
            <button
              className={dangerButton}
              disabled={busy}
              onClick={() => void onAction(job, 'cancel')}
              type="button"
            >
              取消
            </button>
          ) : (
            <span className="text-xs text-ink-500">无可用动作</span>
          )}
        </div>
      </td>
    </tr>
  );
}

function originLabel(origin: PublishJob['origin']) {
  if (origin === 'official_site_automation') return '官网机器质检通过后自动发布';
  if (origin === 'baijiahao_automation') return '百家号自动化发布';
  if (origin === 'douyin_automation') return '抖音图文自动化发布';
  if (origin === 'sohu_automation') return '搜狐号自动化发布';
  if (origin === 'lieju_automation') return '列举网自动化发布';
  return '人工审核内容';
}

function DateField({
  label,
  name,
  value,
}: {
  readonly label: string;
  readonly name: string;
  readonly value?: string | undefined;
}) {
  return (
    <label className={labelClass}>
      {label}
      <input
        className={controlClass}
        defaultValue={toLocalDateTime(value)}
        name={name}
        type="datetime-local"
      />
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
    <label className={labelClass}>
      {label}
      <select className={controlClass} defaultValue={value ?? ''} name={name}>
        <option value="">全部</option>
        {options.map(([option, text]) => (
          <option key={option} value={option}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

function StatePanel({ text, title }: { readonly text: string; readonly title: string }) {
  return (
    <section className="mt-5 rounded-2xl border border-line bg-white p-8 text-center shadow-panel">
      <h2 className="text-xl font-semibold text-ink-950">{title}</h2>
      <p className="mt-3 text-sm text-ink-500">{text}</p>
    </section>
  );
}

function StatusBadge({ status }: { readonly status: PublishJob['status'] }) {
  const text = STATUS_OPTIONS.find(([value]) => value === status)?.[1] ?? status;
  const color =
    status === 'published'
      ? 'bg-emerald-50 text-emerald-700'
      : status === 'failed'
        ? 'bg-red-50 text-red-700'
        : status === 'cancelled' || status === 'cancel_requested'
          ? 'bg-slate-100 text-slate-600'
          : 'bg-amber-50 text-amber-800';
  return <span className={`rounded-full px-3 py-1 text-xs font-semibold ${color}`}>{text}</span>;
}

function parseFilters(data: FormData): PublishingCalendarFilters {
  const accountId = String(data.get('account_id') ?? '').trim();
  const platform = PlatformCodeSchema.safeParse(data.get('platform_code'));
  const status = PublishJobStatusSchema.safeParse(data.get('status'));
  const workspaceId = String(data.get('workspace_id') ?? '').trim();
  const from = toIso(data.get('from'));
  const to = toIso(data.get('to'));
  return {
    ...(accountId ? { accountId } : {}),
    ...(from ? { from } : {}),
    ...(platform.success ? { platformCode: platform.data } : {}),
    ...(status.success ? { status: status.data } : {}),
    ...(to ? { to } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  };
}

function readFilters(): PublishingCalendarFilters {
  if (typeof window === 'undefined') return {};
  const query = new URLSearchParams(window.location.search);
  const data = new FormData();
  for (const key of ['account_id', 'from', 'platform_code', 'status', 'to', 'workspace_id']) {
    data.set(key, query.get(key) ?? '');
  }
  return parseFilters(data);
}

function readSelectedVariantId(): string | null {
  if (typeof window === 'undefined') return null;
  const value = new URLSearchParams(window.location.search).get('variant_id');
  return value && /^[0-9a-f-]{36}$/iu.test(value) ? value : null;
}

function writeFilters(filters: PublishingCalendarFilters, selectedVariantId: string | null) {
  const query = new URLSearchParams();
  if (selectedVariantId) query.set('variant_id', selectedVariantId);
  if (filters.accountId) query.set('account_id', filters.accountId);
  if (filters.from) query.set('from', filters.from);
  if (filters.platformCode) query.set('platform_code', filters.platformCode);
  if (filters.status) query.set('status', filters.status);
  if (filters.to) query.set('to', filters.to);
  if (filters.workspaceId) query.set('workspace_id', filters.workspaceId);
  window.history.replaceState(null, '', query.size ? `/pub-02?${query}` : '/pub-02');
}

function toIso(value: FormDataEntryValue | string | null): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function toLocalDateTime(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function platformLabel(code: PlatformCode) {
  return PLATFORM_OPTIONS.find(([value]) => value === code)?.[1] ?? code;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function isAccessError(error: unknown) {
  const status =
    error instanceof PublishingCalendarRequestError
      ? error.status
      : typeof error === 'object' && error !== null && 'status' in error
        ? (error as { readonly status?: unknown }).status
        : null;
  return typeof status === 'number' && [401, 403, 404].includes(status);
}

function readCookie(name: string) {
  const prefix = `${encodeURIComponent(name)}=`;
  const cookie = document.cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : '';
}

const PLATFORM_OPTIONS = [
  ['official_site', '官网'],
  ['baijiahao', '百家号'],
  ['sohu', '搜狐号'],
  ['lieju', '列举网'],
  ['toutiao', '头条号'],
  ['zhihu', '知乎'],
  ['xiaohongshu', '小红书'],
  ['wechat_mp', '微信公众号'],
  ['douyin', '抖音'],
] as const;

const STATUS_OPTIONS = [
  ['scheduled', '已排期'],
  ['publishing', '发布中'],
  ['published', '已发布'],
  ['failed', '失败'],
  ['cancel_requested', '取消处理中'],
  ['cancelled', '已取消'],
] as const;

const labelClass = 'text-sm text-ink-700';
const controlClass =
  'mt-2 block h-11 w-full rounded-control border border-line bg-white px-3 text-sm text-ink-950 focus:border-brand-500 focus:outline-2 focus:outline-offset-2 disabled:bg-surface-subtle';
const primaryButton =
  'h-11 rounded-control bg-brand-600 px-5 text-sm font-semibold text-white focus:outline-2 focus:outline-offset-2 disabled:opacity-60';
const secondaryButton =
  'h-11 rounded-control border border-line bg-white px-4 text-sm font-semibold text-ink-700 focus:outline-2 focus:outline-offset-2 disabled:opacity-60';
const smallButton =
  'rounded-control border border-line bg-white px-3 py-2 text-xs font-semibold text-ink-700 focus:outline-2 focus:outline-offset-2 disabled:opacity-60';
const primarySmallButton =
  'rounded-control bg-brand-600 px-3 py-2 text-xs font-semibold text-white focus:outline-2 focus:outline-offset-2 disabled:opacity-60';
const dangerButton =
  'rounded-control border border-red-200 bg-white px-3 py-2 text-xs font-semibold text-red-700 focus:outline-2 focus:outline-offset-2 disabled:opacity-60';
