'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { TechnicalDetails } from '../human-readable';
import {
  changeTenantState,
  createPlatformTenant,
  createSupportGrant,
  loadCurrentUser,
  loadPlatformTenants,
  PlatformTenantRequestError,
} from './platform-tenant-api';
import type { PlatformTenant, SupportGrant, TenantFilters } from './platform-tenant.schema';

const EMPTY_FILTERS: TenantFilters = { plan: '', search: '', status: '' };

export function PlatformTenantManager() {
  const [filters, setFilters] = useState<TenantFilters>(readFilters);
  const [items, setItems] = useState<readonly PlatformTenant[]>([]);
  const [userId, setUserId] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'permission' | 'error'>('loading');
  const [showCreate, setShowCreate] = useState(false);
  const [supportTenant, setSupportTenant] = useState<PlatformTenant | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(filters, controller.signal);
    return () => controller.abort();
  }, []);

  async function refresh(nextFilters: TenantFilters, signal?: AbortSignal) {
    setState('loading');
    try {
      const [page, user] = await Promise.all([
        loadPlatformTenants(nextFilters, signal),
        loadCurrentUser(signal),
      ]);
      if (signal?.aborted) return;
      setItems(page.items);
      setUserId(user.id);
      setState('ready');
    } catch (error) {
      if (signal?.aborted) return;
      setState(
        error instanceof PlatformTenantRequestError && error.status === 403
          ? 'permission'
          : 'error',
      );
    }
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = {
      plan: String(form.get('plan') ?? '').trim(),
      search: String(form.get('search') ?? '').trim(),
      status: String(form.get('status') ?? '').trim(),
    };
    setFilters(next);
    writeFilters(next);
    void refresh(next);
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const csrf = readCookie('geo_csrf');
    if (!csrf) return setMessage('安全令牌尚未就绪，请刷新后重试。');
    const form = new FormData(event.currentTarget);
    setBusyId('create');
    setMessage(null);
    try {
      const tenant = await createPlatformTenant(
        {
          name: String(form.get('name')),
          ownerDisplayName: String(form.get('owner_display_name')),
          ownerEmail: String(form.get('owner_email')),
          planCode: String(form.get('plan_code')),
          slug: String(form.get('slug')),
          timezone: String(form.get('timezone')),
          workspaceName: String(form.get('workspace_name')),
        },
        csrf,
      );
      setItems((current) => [tenant, ...current]);
      setShowCreate(false);
      setMessage('企业、管理员邀请和默认工作区已创建。');
    } catch {
      setMessage('创建失败；请检查企业标识、管理员邮箱或重复数据。');
    } finally {
      setBusyId(null);
    }
  }

  async function transition(tenant: PlatformTenant, action: 'restore' | 'suspend') {
    const csrf = readCookie('geo_csrf');
    if (!csrf) return setMessage('安全令牌尚未就绪，请刷新后重试。');
    const reason =
      action === 'suspend' ? window.prompt('请输入暂停原因（将写入审计日志）') : undefined;
    if (action === 'suspend' && !reason?.trim()) return;
    setBusyId(tenant.id);
    setMessage(null);
    try {
      const updated = await changeTenantState(tenant, action, csrf, reason ?? undefined);
      setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setMessage(action === 'suspend' ? '企业账号已暂停。' : '企业账号已恢复。');
    } catch {
      setMessage('状态变更失败；企业状态可能已变化，请刷新后重试。');
    } finally {
      setBusyId(null);
    }
  }

  if (state === 'loading' && items.length === 0)
    return <StatePanel busy title="正在加载企业" text="正在读取企业状态与汇总用量。" />;
  if (state === 'permission')
    return <StatePanel title="无权管理企业" text="该页面仅对平台管理员开放。" />;
  if (state === 'error')
    return <StatePanel title="无法加载企业" text="请检查网络、登录状态或平台权限。" />;

  return (
    <section className="space-y-6">
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
        本页面只展示企业状态和汇总用量，不会直接读取企业内容。需要协助排障时，必须先获得限时授权。
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterForm
          filters={filters}
          onReset={() => resetFilters(setFilters, refresh)}
          onSubmit={applyFilters}
        />
        <button
          className={primaryButton}
          onClick={() => setShowCreate((value) => !value)}
          type="button"
        >
          {showCreate ? '取消创建' : '创建企业'}
        </button>
      </div>
      {showCreate ? <CreateTenantForm busy={busyId === 'create'} onSubmit={create} /> : null}
      <div aria-live="polite" className="min-h-6 text-sm text-ink-700" role="status">
        {message}
      </div>
      {items.length === 0 ? (
        <StatePanel title="暂无企业" text="当前筛选范围内没有匹配企业。" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {items.map((tenant) => (
            <TenantCard
              busy={busyId === tenant.id}
              key={tenant.id}
              onStateChange={(action) => void transition(tenant, action)}
              onSupport={() => setSupportTenant(tenant)}
              tenant={tenant}
            />
          ))}
        </div>
      )}
      {supportTenant ? (
        <SupportGrantPanel
          onClose={() => setSupportTenant(null)}
          onMessage={setMessage}
          tenant={supportTenant}
          userId={userId}
        />
      ) : null}
    </section>
  );
}

function FilterForm({
  filters,
  onReset,
  onSubmit,
}: {
  readonly filters: TenantFilters;
  readonly onReset: () => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form
      className="flex flex-1 flex-wrap items-end gap-3"
      key={JSON.stringify(filters)}
      onSubmit={onSubmit}
    >
      <Field label="搜索企业" name="tenant-search">
        <input
          className={controlClass}
          defaultValue={filters.search}
          id="tenant-search"
          name="search"
        />
      </Field>
      <Field label="状态" name="tenant-status">
        <select
          className={controlClass}
          defaultValue={filters.status}
          id="tenant-status"
          name="status"
        >
          <option value="">全部</option>
          <option value="active">正常</option>
          <option value="suspended">已暂停</option>
          <option value="archived">已归档</option>
        </select>
      </Field>
      <Field label="套餐" name="tenant-plan">
        <input className={controlClass} defaultValue={filters.plan} id="tenant-plan" name="plan" />
      </Field>
      <button className={secondaryButton} type="submit">
        筛选
      </button>
      <button className={secondaryButton} onClick={onReset} type="button">
        重置
      </button>
    </form>
  );
}

function CreateTenantForm({
  busy,
  onSubmit,
}: {
  readonly busy: boolean;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="rounded-2xl border border-line bg-white p-5 shadow-panel" onSubmit={onSubmit}>
      <h2 className="text-lg font-semibold text-ink-950">创建企业</h2>
      <p className="mt-1 text-sm text-ink-500">提交后将同时创建管理员邀请和默认工作区。</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <TextInput label="企业名称" name="name" required />
        <TextInput label="企业网址标识" name="slug" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required />
        <TextInput defaultValue="trial" label="套餐" name="plan_code" required />
        <TextInput defaultValue="Asia/Shanghai" label="时区" name="timezone" required />
        <TextInput label="管理员邮箱" name="owner_email" required type="email" />
        <TextInput label="管理员姓名" name="owner_display_name" required />
        <TextInput
          defaultValue="默认工作区"
          label="默认工作区名称"
          name="workspace_name"
          required
        />
      </div>
      <button className={`${primaryButton} mt-5`} disabled={busy} type="submit">
        {busy ? '正在创建…' : '确认创建'}
      </button>
    </form>
  );
}

function TenantCard({
  tenant,
  busy,
  onStateChange,
  onSupport,
}: {
  readonly tenant: PlatformTenant;
  readonly busy: boolean;
  readonly onStateChange: (action: 'restore' | 'suspend') => void;
  readonly onSupport: () => void;
}) {
  return (
    <article className="rounded-2xl border border-line bg-white p-5 shadow-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink-950">{tenant.name}</h2>
          <p className="mt-1 text-xs text-ink-500">企业标识：{tenant.slug}</p>
        </div>
        <Status status={tenant.status} />
      </div>
      <dl className="mt-5 grid grid-cols-2 gap-4 text-sm">
        <Metric label="套餐" value={planLabel(tenant.plan_code)} />
        <Metric label="健康" value={healthLabel(tenant.health.status)} />
        <Metric label="本月已结算成本" value={money(tenant.usage.settled_cost_cents)} />
        <Metric label="本月计费记录" value={String(tenant.usage.ledger_entries)} />
        <Metric label="时区" value={tenant.timezone} />
      </dl>
      <div className="mt-4">
        <TechnicalDetails summary="企业技术信息">
          <p>企业编号：{tenant.id}</p>
          <p>套餐代码：{tenant.plan_code}</p>
          <p>数据版本：{tenant.version}</p>
        </TechnicalDetails>
      </div>
      <div className="mt-5 flex flex-wrap gap-3">
        {tenant.status === 'active' ? (
          <button
            className={dangerButton}
            disabled={busy}
            onClick={() => onStateChange('suspend')}
            type="button"
          >
            暂停
          </button>
        ) : tenant.status === 'suspended' ? (
          <button
            className={primaryButton}
            disabled={busy}
            onClick={() => onStateChange('restore')}
            type="button"
          >
            恢复
          </button>
        ) : null}
        {tenant.status === 'active' ? (
          <button className={secondaryButton} onClick={onSupport} type="button">
            申请限时支持授权
          </button>
        ) : null}
      </div>
    </article>
  );
}

function SupportGrantPanel({
  tenant,
  userId,
  onClose,
  onMessage,
}: {
  readonly tenant: PlatformTenant;
  readonly userId: string;
  readonly onClose: () => void;
  readonly onMessage: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [grant, setGrant] = useState<SupportGrant | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const csrf = readCookie('geo_csrf');
    if (!csrf || !userId) return onMessage('安全令牌或当前用户信息尚未就绪。');
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      const created = await createSupportGrant(
        {
          hours: Number(form.get('hours')),
          platformUserId: userId,
          reason: String(form.get('reason')),
          tenantId: tenant.id,
        },
        csrf,
      );
      setGrant(created);
      onMessage('限时支持授权已创建；后续内容读取仍必须携带该授权并写审计。');
    } catch {
      onMessage('授权创建失败；请检查企业状态、原因、有效期或平台管理员身份。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside
      aria-label="限时支持授权"
      className="rounded-2xl border border-brand-200 bg-brand-50 p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-ink-950">{tenant.name} · 限时支持授权</h2>
          <p className="mt-1 text-sm leading-6 text-ink-600">
            此处只创建最小范围的临时授权，不会立即读取企业内容。
          </p>
        </div>
        <button className={secondaryButton} onClick={onClose} type="button">
          关闭
        </button>
      </div>
      {grant ? (
        <div className="mt-4 text-sm text-ink-800">
          <p>授权已生效，有效期至 {formatTime(grant.expires_at)}。</p>
          <TechnicalDetails summary="授权技术信息">
            <p>授权编号：{grant.id}</p>
          </TechnicalDetails>
        </div>
      ) : (
        <form
          className="mt-4 grid gap-4 sm:grid-cols-[1fr_10rem_auto] sm:items-end"
          onSubmit={submit}
        >
          <TextInput label="授权原因" name="reason" required />
          <Field label="有效时长" name="support-hours">
            <select className={controlClass} defaultValue="1" id="support-hours" name="hours">
              <option value="1">1 小时</option>
              <option value="4">4 小时</option>
              <option value="8">8 小时</option>
            </select>
          </Field>
          <button className={primaryButton} disabled={busy} type="submit">
            {busy ? '正在授权…' : '创建授权'}
          </button>
        </form>
      )}
    </aside>
  );
}

function TextInput({
  label,
  name,
  ...props
}: {
  readonly label: string;
  readonly name: string;
  readonly defaultValue?: string;
  readonly pattern?: string;
  readonly required?: boolean;
  readonly type?: string;
}) {
  return (
    <Field label={label} name={name}>
      <input className={controlClass} id={name} name={name} {...props} />
    </Field>
  );
}
function Field({
  label,
  name,
  children,
}: {
  readonly label: string;
  readonly name: string;
  readonly children: ReactNode;
}) {
  return (
    <label className="grid gap-1 text-sm font-medium text-ink-700" htmlFor={name}>
      {label}
      {children}
    </label>
  );
}
function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className="mt-1 font-medium text-ink-900">{value}</dd>
    </div>
  );
}
function Status({ status }: { readonly status: PlatformTenant['status'] }) {
  const labels = { active: '正常', archived: '已归档', suspended: '已暂停' };
  return (
    <span className="rounded-full bg-surface-subtle px-3 py-1 text-xs font-semibold text-ink-700">
      {labels[status]}
    </span>
  );
}
function StatePanel({
  title,
  text,
  busy = false,
}: {
  readonly title: string;
  readonly text: string;
  readonly busy?: boolean;
}) {
  return (
    <section
      aria-busy={busy}
      className="rounded-2xl border border-line bg-white p-8 text-center shadow-panel"
    >
      <h2 className="text-lg font-semibold text-ink-950">{title}</h2>
      <p className="mt-2 text-sm text-ink-500">{text}</p>
    </section>
  );
}
function healthLabel(status: PlatformTenant['health']['status']) {
  return status === 'healthy' ? '健康' : status === 'suspended' ? '已暂停' : '已归档';
}
function planLabel(value: string) {
  return (
    { trial: '试用版', standard: '标准版', professional: '专业版', enterprise: '企业版' }[value] ??
    value
  );
}
function money(cents: number) {
  return new Intl.NumberFormat('zh-CN', { currency: 'CNY', style: 'currency' }).format(cents / 100);
}
function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}
function readCookie(name: string) {
  const entry = document.cookie.split('; ').find((value) => value.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
}
function readFilters(): TenantFilters {
  if (typeof window === 'undefined') return EMPTY_FILTERS;
  const query = new URLSearchParams(window.location.search);
  return {
    plan: query.get('plan') ?? '',
    search: query.get('search') ?? '',
    status: query.get('status') ?? '',
  };
}
function writeFilters(filters: TenantFilters) {
  const query = new URLSearchParams();
  if (filters.search) query.set('search', filters.search);
  if (filters.status) query.set('status', filters.status);
  if (filters.plan) query.set('plan', filters.plan);
  window.history.replaceState(null, '', `/plat-01${query.size ? `?${query}` : ''}`);
}
function resetFilters(
  setFilters: (value: TenantFilters) => void,
  refresh: (filters: TenantFilters) => Promise<void>,
) {
  setFilters(EMPTY_FILTERS);
  writeFilters(EMPTY_FILTERS);
  void refresh(EMPTY_FILTERS);
}

const controlClass =
  'min-h-11 rounded-xl border border-line bg-white px-3 text-sm text-ink-950 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';
const primaryButton =
  'min-h-11 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50';
const secondaryButton =
  'min-h-11 rounded-xl border border-line bg-white px-4 py-2 text-sm font-semibold text-ink-800 hover:border-brand-300 hover:text-brand-700';
const dangerButton =
  'min-h-11 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50';
