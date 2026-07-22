'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import { listWorkspaces } from '../set-02/workspace-settings-api';
import type { Workspace } from '../set-02/workspace-settings.schema';
import {
  createPlatformAccount,
  disablePlatformAccount,
  listPlatformAccounts,
  PlatformAccountRequestError,
  refreshPlatformAccount,
  removePlatformAccount,
  restorePlatformAccount,
  testPlatformAccount,
  updatePlatformAccount,
} from './platform-account-api';
import {
  PlatformAccountEditSchema,
  PlatformAccountFormSchema,
  PlatformAccountStatusSchema,
  PlatformCodeSchema,
  type PlatformAccount,
  type PlatformAccountFilters,
} from './platform-account.schema';
import { resolvePublishingUrl } from './platform-publishing-url';

const PUBLISH_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'publisher']);

export function PlatformAccountManager() {
  const [filters, setFilters] = useState<PlatformAccountFilters>(readFilters);
  const [accounts, setAccounts] = useState<PlatformAccount[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'permission'>('loading');
  const [showConnect, setShowConnect] = useState(false);
  const [editingAccount, setEditingAccount] = useState<PlatformAccount | null>(null);
  const [publishMode, setPublishMode] = useState<'api' | 'export' | 'manual'>('export');
  const [editMode, setEditMode] = useState<'api' | 'export' | 'manual'>('export');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async (next: PlatformAccountFilters, signal?: AbortSignal) => {
    setState('loading');
    try {
      const tenants = await listAvailableTenants(signal);
      const role = tenants.find((tenant) => tenant.is_active)?.role_code;
      if (!role || !PUBLISH_ROLES.has(role)) {
        setState('permission');
        return;
      }
      const [accountItems, workspaceItems] = await Promise.all([
        listPlatformAccounts(next, signal),
        listWorkspaces(signal),
      ]);
      if (signal?.aborted) return;
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
    writeFilters(next);
  }

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const parsed = PlatformAccountFormSchema.safeParse({
      base_url: String(data.get('base_url') ?? ''),
      bearer_token: String(data.get('bearer_token') ?? ''),
      display_name: String(data.get('display_name') ?? ''),
      platform_code: data.get('platform_code'),
      publishing_url: String(data.get('publishing_url') ?? ''),
      publish_mode: data.get('publish_mode'),
      timezone: String(data.get('timezone') ?? ''),
      workspace_id: String(data.get('workspace_id') ?? ''),
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? '请检查连接信息。');
      return;
    }
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setFormError('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    setConnecting(true);
    setFormError(null);
    try {
      await createPlatformAccount(parsed.data, csrf);
      form.reset();
      setPublishMode('export');
      setShowConnect(false);
      setMessage('平台账号已连接；凭证已安全保存且不会回显。');
      await load(filters);
    } catch {
      setFormError('连接失败，请核对授权信息与平台能力后重试。');
    } finally {
      setConnecting(false);
    }
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingAccount) return;
    const data = new FormData(event.currentTarget);
    const parsed = PlatformAccountEditSchema.safeParse({
      base_url: String(data.get('base_url') ?? ''),
      bearer_token: String(data.get('bearer_token') ?? ''),
      display_name: String(data.get('display_name') ?? ''),
      publishing_url: String(data.get('publishing_url') ?? ''),
      publish_mode: data.get('publish_mode'),
      timezone: String(data.get('timezone') ?? ''),
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? '请检查账号信息。');
      return;
    }
    if (
      editingAccount.publish_mode !== 'api' &&
      parsed.data.publish_mode === 'api' &&
      (!parsed.data.base_url.trim() || !parsed.data.bearer_token.trim())
    ) {
      setFormError('切换到 API 发布时必须填写 API 地址和访问令牌。');
      return;
    }
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setFormError('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    setBusyId(editingAccount.id);
    setFormError(null);
    try {
      await updatePlatformAccount(editingAccount, parsed.data, csrf);
      setEditingAccount(null);
      setMessage('账号信息已保存。新凭证已替换旧凭证，且不会在页面回显。');
      await load(filters);
    } catch {
      setFormError('保存失败，请核对新凭证和平台连接信息后重试。');
    } finally {
      setBusyId(null);
    }
  }

  async function runLifecycleAction(
    account: PlatformAccount,
    action: 'refresh' | 'test' | 'disable' | 'restore' | 'remove',
  ) {
    if (action === 'remove') {
      const confirmed = window.confirm(
        `确认删除“${account.display_name}”？删除后不会再出现在账号列表中。`,
      );
      if (!confirmed) return;
    }
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    let reason = '';
    if (action === 'disable') {
      reason = window.prompt('请输入停用原因，例如“账号已注销”或“授权已失效”。')?.trim() ?? '';
      if (!reason) return;
    }
    setBusyId(account.id);
    setMessage(null);
    try {
      if (action === 'refresh') await refreshPlatformAccount(account, csrf);
      if (action === 'test') await testPlatformAccount(account, csrf);
      if (action === 'disable') await disablePlatformAccount(account, reason, csrf);
      if (action === 'restore') await restorePlatformAccount(account, csrf);
      if (action === 'remove') await removePlatformAccount(account, csrf);
      setMessage(ACTION_MESSAGES[action]);
      await load(filters);
    } catch (error) {
      setMessage(
        error instanceof PlatformAccountRequestError && error.status === 409
          ? '该账号仍有待发布任务，请先取消相关任务，再停用或删除账号。'
          : '操作失败；账号版本、凭证或平台能力可能已变化，请刷新后重试。',
      );
    } finally {
      setBusyId(null);
    }
  }

  if (state === 'permission') {
    return <StatePanel title="无权管理平台账号" text="仅发布人、企业管理员和所有者可访问。" />;
  }
  if (state === 'error') {
    return <StatePanel title="无法加载平台账号" text="请检查网络或服务状态后重试。" />;
  }

  return (
    <section className="mt-8">
      <div className="flex flex-col gap-4 rounded-2xl border border-line bg-white p-4 shadow-panel sm:flex-row sm:items-end sm:justify-between">
        <form
          aria-label="平台账号筛选"
          className="grid flex-1 gap-4 sm:grid-cols-3"
          key={JSON.stringify(filters)}
          onSubmit={applyFilters}
        >
          <SelectField
            label="平台"
            name="platform_code"
            options={PLATFORM_OPTIONS}
            value={filters.platformCode}
          />
          <SelectField
            label="授权状态"
            name="status"
            options={STATUS_OPTIONS}
            value={filters.status}
          />
          <label className="text-sm text-ink-700">
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
          <div className="flex gap-3 sm:col-span-3">
            <button className={secondaryButton} type="submit">
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
        </form>
        <button
          className={primaryButton}
          onClick={() => {
            setEditingAccount(null);
            setFormError(null);
            setShowConnect((value) => !value);
          }}
          type="button"
        >
          {showConnect ? '取消连接' : '连接账号'}
        </button>
      </div>

      {showConnect ? (
        <ConnectForm
          connecting={connecting}
          error={formError}
          onModeChange={setPublishMode}
          onSubmit={connect}
          publishMode={publishMode}
          workspaces={workspaces}
        />
      ) : null}

      {editingAccount ? (
        <EditForm
          account={editingAccount}
          busy={busyId === editingAccount.id}
          error={formError}
          onCancel={() => {
            setEditingAccount(null);
            setFormError(null);
          }}
          onModeChange={setEditMode}
          onSubmit={saveEdit}
          publishMode={editMode}
        />
      ) : null}

      <div aria-live="polite" className="mt-4 min-h-6 text-sm text-ink-700">
        {message}
      </div>

      {state === 'loading' ? (
        <StatePanel title="正在加载平台账号" text="正在读取当前授权范围内的账号与能力。" />
      ) : accounts.length === 0 ? (
        <StatePanel title="暂无平台账号" text="当前筛选下没有账号，可使用“连接账号”创建。" />
      ) : (
        <div className="mt-5 overflow-x-auto rounded-2xl border border-line bg-white shadow-panel">
          <table className="w-full min-w-[1080px] text-left text-sm">
            <thead className="bg-surface-subtle text-ink-500">
              <tr>
                <th className="p-4">平台 / 账号</th>
                <th className="p-4">能力</th>
                <th className="p-4">授权状态</th>
                <th className="p-4">到期</th>
                <th className="p-4">时区</th>
                <th className="p-4">动作</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <AccountRow
                  account={account}
                  busy={busyId === account.id}
                  key={account.id}
                  onAction={runLifecycleAction}
                  onEdit={(selected) => {
                    setShowConnect(false);
                    setFormError(null);
                    setEditingAccount(selected);
                    setEditMode(selected.publish_mode);
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function EditForm({
  account,
  busy,
  error,
  onCancel,
  onModeChange,
  onSubmit,
  publishMode,
}: {
  readonly account: PlatformAccount;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onModeChange: (mode: 'api' | 'export' | 'manual') => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  readonly publishMode: 'api' | 'export' | 'manual';
}) {
  return (
    <form
      aria-label={`编辑账号 ${account.display_name}`}
      className="mt-5 rounded-2xl border border-brand-200 bg-white p-5 shadow-panel sm:p-7"
      key={account.id}
      noValidate
      onSubmit={(event) => void onSubmit(event)}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-ink-950">编辑账号</h2>
          <p className="mt-2 text-sm text-ink-500">
            {platformLabel(account.platform_code)} ·
            平台和工作区不可更改。如密码或令牌已变更，请在下方输入新凭证。
          </p>
        </div>
        <button className={secondaryButton} onClick={onCancel} type="button">
          取消
        </button>
      </div>
      <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        <label className="text-sm text-ink-700">
          账号名称
          <input
            className={controlClass}
            defaultValue={account.display_name}
            maxLength={120}
            name="display_name"
            required
          />
        </label>
        <label className="text-sm text-ink-700">
          交付模式
          <select
            className={controlClass}
            name="publish_mode"
            onChange={(event) =>
              onModeChange(event.currentTarget.value as 'api' | 'export' | 'manual')
            }
            value={publishMode}
          >
            <option value="api">API 发布</option>
            <option value="export">确定性导出</option>
            <option value="manual">人工发布</option>
          </select>
        </label>
        <label className="text-sm text-ink-700">
          时区
          <input
            className={controlClass}
            defaultValue={account.timezone}
            name="timezone"
            required
          />
        </label>
        <label className="text-sm text-ink-700 sm:col-span-2 lg:col-span-3">
          发布后台地址（可选）
          <input
            className={controlClass}
            defaultValue={account.publishing_url ?? ''}
            name="publishing_url"
            placeholder="官网 CMS 地址，或用于覆盖平台默认发布页面"
            type="url"
          />
        </label>
        {publishMode === 'api' ? (
          <>
            <label className="text-sm text-ink-700">
              新 API 地址
              <input
                autoComplete="url"
                className={controlClass}
                name="base_url"
                placeholder="不修改凭证可留空"
                type="url"
              />
            </label>
            <label className="text-sm text-ink-700">
              新访问令牌
              <input
                autoComplete="new-password"
                className={controlClass}
                name="bearer_token"
                placeholder="不修改凭证可留空"
                type="password"
              />
            </label>
          </>
        ) : (
          <>
            <input name="base_url" type="hidden" value="" />
            <input name="bearer_token" type="hidden" value="" />
          </>
        )}
      </div>
      <div aria-live="polite" className="mt-4 min-h-6 text-sm text-red-700">
        {error}
      </div>
      <div className="mt-3 flex justify-end">
        <button className={primaryButton} disabled={busy} type="submit">
          {busy ? '正在保存…' : '保存修改'}
        </button>
      </div>
    </form>
  );
}

function ConnectForm({
  connecting,
  error,
  onModeChange,
  onSubmit,
  publishMode,
  workspaces,
}: {
  readonly connecting: boolean;
  readonly error: string | null;
  readonly onModeChange: (mode: 'api' | 'export' | 'manual') => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  readonly publishMode: 'api' | 'export' | 'manual';
  readonly workspaces: readonly Workspace[];
}) {
  return (
    <form
      aria-label="连接平台账号"
      className="mt-5 rounded-2xl border border-line bg-white p-5 shadow-panel sm:p-7"
      noValidate
      onSubmit={(event) => void onSubmit(event)}
    >
      <h2 className="text-xl font-semibold text-ink-950">连接平台账号</h2>
      <p className="mt-2 text-sm text-ink-500">
        现有凭证不会读取或回显；API 模式仅接受本次输入的新凭证。
      </p>
      <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        <label className="text-sm text-ink-700">
          工作区
          <select className={controlClass} defaultValue="" name="workspace_id" required>
            <option disabled value="">
              请选择工作区
            </option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </label>
        <SelectField
          label="平台"
          name="platform_code"
          options={PLATFORM_OPTIONS}
          value="official_site"
          required
        />
        <label className="text-sm text-ink-700">
          账号名称
          <input className={controlClass} maxLength={120} name="display_name" required />
        </label>
        <label className="text-sm text-ink-700">
          交付模式
          <select
            className={controlClass}
            name="publish_mode"
            onChange={(event) =>
              onModeChange(event.currentTarget.value as 'api' | 'export' | 'manual')
            }
            value={publishMode}
          >
            <option value="api">API 发布</option>
            <option value="export">确定性导出</option>
            <option value="manual">人工发布</option>
          </select>
        </label>
        <label className="text-sm text-ink-700">
          时区
          <input className={controlClass} defaultValue="Asia/Shanghai" name="timezone" required />
        </label>
        <label className="text-sm text-ink-700 sm:col-span-2 lg:col-span-3">
          发布后台地址（可选）
          <input
            className={controlClass}
            name="publishing_url"
            placeholder="官网请填写 CMS 发布页；其他平台不填则使用默认创作页面"
            type="url"
          />
        </label>
        {publishMode === 'api' ? (
          <>
            <label className="text-sm text-ink-700">
              API 地址
              <input
                autoComplete="url"
                className={controlClass}
                name="base_url"
                placeholder="https://api.example.com"
                type="url"
              />
            </label>
            <label className="text-sm text-ink-700 sm:col-span-2 lg:col-span-1">
              访问令牌
              <input
                autoComplete="new-password"
                className={controlClass}
                name="bearer_token"
                type="password"
              />
            </label>
          </>
        ) : (
          <input name="base_url" type="hidden" value="" />
        )}
        {publishMode !== 'api' ? <input name="bearer_token" type="hidden" value="" /> : null}
      </div>
      <div aria-live="polite" className="mt-4 min-h-6 text-sm text-red-700">
        {error}
      </div>
      <div className="mt-3 flex justify-end">
        <button
          className={primaryButton}
          disabled={connecting || workspaces.length === 0}
          type="submit"
        >
          {connecting ? '正在连接…' : '确认连接'}
        </button>
      </div>
    </form>
  );
}

function AccountRow({
  account,
  busy,
  onAction,
  onEdit,
}: {
  readonly account: PlatformAccount;
  readonly busy: boolean;
  readonly onAction: (
    account: PlatformAccount,
    action: 'refresh' | 'test' | 'disable' | 'restore' | 'remove',
  ) => Promise<void>;
  readonly onEdit: (account: PlatformAccount) => void;
}) {
  const disabled = account.status === 'disabled';
  const publishingUrl = resolvePublishingUrl(account);
  return (
    <tr className="border-t border-line">
      <td className="p-4">
        <span className="font-semibold text-ink-950">{platformLabel(account.platform_code)}</span>
        <p className="mt-1">{account.display_name}</p>
        <p className="mt-1 text-xs text-ink-500">{modeLabel(account.publish_mode)}</p>
      </td>
      <td className="p-4">{capabilitySummary(account.capabilities)}</td>
      <td className="p-4">
        <StatusBadge status={account.status} />
      </td>
      <td className="p-4">
        {account.token_expires_at ? formatDate(account.token_expires_at) : '未提供'}
      </td>
      <td className="p-4">{account.timezone}</td>
      <td className="p-4">
        <div className="flex flex-wrap gap-2">
          {publishingUrl && !disabled ? (
            <a
              className={primarySmallButton}
              href={publishingUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              前往发布后台
            </a>
          ) : null}
          <button
            className={smallButton}
            disabled={busy}
            onClick={() => onEdit(account)}
            type="button"
          >
            编辑
          </button>
          {account.publish_mode === 'api' && !disabled ? (
            <button
              className={smallButton}
              disabled={busy}
              onClick={() => void onAction(account, 'refresh')}
              type="button"
            >
              刷新授权状态
            </button>
          ) : null}
          {!disabled ? (
            <button
              className={smallButton}
              disabled={busy}
              onClick={() => void onAction(account, 'test')}
              type="button"
            >
              能力测试
            </button>
          ) : null}
          {!disabled ? (
            <button
              className={dangerButton}
              disabled={busy}
              onClick={() => void onAction(account, 'disable')}
              type="button"
            >
              停用
            </button>
          ) : null}
          {disabled ? (
            <button
              className={smallButton}
              disabled={busy}
              onClick={() => void onAction(account, 'restore')}
              type="button"
            >
              恢复使用
            </button>
          ) : null}
          <button
            className={dangerButton}
            disabled={busy}
            onClick={() => void onAction(account, 'remove')}
            type="button"
          >
            删除
          </button>
        </div>
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
  ['active', '已授权'],
  ['reauth', '需重新授权'],
  ['disabled', '已禁用'],
] as const;
const ACTION_MESSAGES = {
  disable: '平台账号已停用，不会再用于新发布任务。',
  remove: '平台账号已删除。',
  refresh: '授权状态已刷新。',
  restore: '平台账号已恢复使用。',
  test: '能力测试已完成。',
} as const;

function parseFilters(data: FormData): PlatformAccountFilters {
  const platform = PlatformCodeSchema.safeParse(data.get('platform_code'));
  const status = PlatformAccountStatusSchema.safeParse(data.get('status'));
  const workspaceId = String(data.get('workspace_id') ?? '').trim();
  return {
    ...(platform.success ? { platformCode: platform.data } : {}),
    ...(status.success ? { status: status.data } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  };
}

function readFilters(): PlatformAccountFilters {
  if (typeof window === 'undefined') return {};
  const query = new URLSearchParams(window.location.search);
  const data = new FormData();
  data.set('platform_code', query.get('platform_code') ?? '');
  data.set('status', query.get('status') ?? '');
  data.set('workspace_id', query.get('workspace_id') ?? '');
  return parseFilters(data);
}

function writeFilters(filters: PlatformAccountFilters) {
  const query = new URLSearchParams();
  if (filters.platformCode) query.set('platform_code', filters.platformCode);
  if (filters.status) query.set('status', filters.status);
  if (filters.workspaceId) query.set('workspace_id', filters.workspaceId);
  window.history.replaceState(null, '', query.size ? `/pub-01?${query}` : '/pub-01');
}

function SelectField({
  label,
  name,
  options,
  required,
  value,
}: {
  readonly label: string;
  readonly name: string;
  readonly options: readonly (readonly [string, string])[];
  readonly required?: boolean;
  readonly value?: string | undefined;
}) {
  return (
    <label className="text-sm text-ink-700">
      {label}
      <select className={controlClass} defaultValue={value ?? ''} name={name} required={required}>
        {!required ? <option value="">全部</option> : null}
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

function StatusBadge({ status }: { readonly status: PlatformAccount['status'] }) {
  const text = status === 'active' ? '已授权' : status === 'reauth' ? '需重新授权' : '已禁用';
  const color =
    status === 'active'
      ? 'bg-emerald-50 text-emerald-700'
      : status === 'reauth'
        ? 'bg-amber-50 text-amber-800'
        : 'bg-slate-100 text-slate-600';
  return <span className={`rounded-full px-3 py-1 text-xs font-semibold ${color}`}>{text}</span>;
}

function capabilitySummary(value: Readonly<Record<string, unknown>>) {
  const enabled = Object.entries(value)
    .filter(([, capability]) => capability === true)
    .map(([name]) => CAPABILITY_LABELS[name] ?? name);
  return enabled.length ? enabled.join('、') : '仅导出或未探测';
}

const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  export: '导出',
  get_status: '状态查询',
  metrics: '指标',
  publish: '发布',
};
function platformLabel(code: PlatformAccount['platform_code']) {
  return PLATFORM_OPTIONS.find(([value]) => value === code)?.[1] ?? code;
}
function modeLabel(mode: PlatformAccount['publish_mode']) {
  return mode === 'api' ? 'API 发布' : mode === 'export' ? '确定性导出' : '人工发布';
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}
function isAccessError(error: unknown) {
  return (
    error instanceof PlatformAccountRequestError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
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

const controlClass =
  'mt-2 block h-11 w-full rounded-control border border-line bg-white px-3 text-sm text-ink-950 focus:border-brand-500 focus:outline-2 focus:outline-offset-2 disabled:bg-surface-subtle';
const primaryButton =
  'h-11 rounded-control bg-brand-600 px-5 text-sm font-semibold text-white focus:outline-2 focus:outline-offset-2 disabled:opacity-60';
const secondaryButton =
  'h-11 rounded-control border border-line bg-white px-4 text-sm font-semibold text-ink-700 focus:outline-2 focus:outline-offset-2 disabled:opacity-60';
const smallButton =
  'rounded-control border border-line bg-white px-3 py-2 text-xs font-semibold text-ink-700 focus:outline-2 focus:outline-offset-2 disabled:opacity-60';
const dangerButton =
  'rounded-control border border-red-200 bg-white px-3 py-2 text-xs font-semibold text-red-700 focus:outline-2 focus:outline-offset-2 disabled:opacity-60';
const primarySmallButton =
  'rounded-control bg-brand-600 px-3 py-2 text-xs font-semibold text-white focus:outline-2 focus:outline-offset-2';
