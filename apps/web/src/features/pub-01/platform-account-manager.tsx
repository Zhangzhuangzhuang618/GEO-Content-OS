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
import { OfficialSiteAutomationPanel } from './official-site-automation-panel';
import { BaijiahaoAutomationPanel } from './baijiahao-automation-panel';

const PUBLISH_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'publisher']);

export function PlatformAccountManager() {
  const [filters, setFilters] = useState<PlatformAccountFilters>(readFilters);
  const [accounts, setAccounts] = useState<PlatformAccount[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'permission'>('loading');
  const [showConnect, setShowConnect] = useState(false);
  const [editingAccount, setEditingAccount] = useState<PlatformAccount | null>(null);
  const [automationAccount, setAutomationAccount] = useState<PlatformAccount | null>(null);
  const [platformCode, setPlatformCode] =
    useState<PlatformAccount['platform_code']>('official_site');
  const [publishMode, setPublishMode] = useState<'api' | 'export' | 'manual'>('api');
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
      setPlatformCode('official_site');
      setPublishMode('api');
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
      editingAccount.platform_code !== 'baijiahao' &&
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
          : '操作失败；账号信息、访问凭证或平台连接可能已变化，请刷新后重试。',
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
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-line bg-white p-5 shadow-panel">
        <div>
          <h2 className="text-lg font-semibold text-ink-950">发布到哪里</h2>
          <p className="mt-1 text-sm leading-6 text-ink-500">
            每个账号只需设置一次；创建发布任务时直接选择即可。
          </p>
        </div>
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

      <details
        className="group mt-4 overflow-hidden rounded-2xl border border-line bg-white shadow-panel"
        open={Object.keys(filters).length > 0 ? true : undefined}
      >
        <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-5 py-3">
          <span className="font-medium text-ink-900">查找账号（可选）</span>
          <span className="text-sm font-semibold text-brand-700 group-open:hidden">展开</span>
          <span className="hidden text-sm font-semibold text-brand-700 group-open:inline">
            收起
          </span>
        </summary>
        <form
          aria-label="平台账号筛选"
          className="grid gap-4 border-t border-line p-5 sm:grid-cols-3"
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
            label="连接状态"
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
              查找
            </button>
            <button
              className={secondaryButton}
              onClick={() => {
                setFilters({});
                writeFilters({});
              }}
              type="button"
            >
              重置
            </button>
          </div>
        </form>
      </details>

      {showConnect ? (
        <ConnectForm
          connecting={connecting}
          error={formError}
          onModeChange={setPublishMode}
          onPlatformChange={(next) => {
            setPlatformCode(next);
            setPublishMode(next === 'official_site' || next === 'baijiahao' ? 'api' : 'export');
          }}
          onSubmit={connect}
          platformCode={platformCode}
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

      {automationAccount ? (
        automationAccount.platform_code === 'baijiahao' ? (
          <BaijiahaoAutomationPanel
            account={automationAccount}
            onClose={() => setAutomationAccount(null)}
          />
        ) : (
          <OfficialSiteAutomationPanel
            account={automationAccount}
            onClose={() => setAutomationAccount(null)}
          />
        )
      ) : null}

      <div aria-live="polite" className="mt-4 min-h-6 text-sm text-ink-700">
        {message}
      </div>

      {state === 'loading' ? (
        <StatePanel title="正在加载平台账号" text="正在读取当前授权范围内的账号与能力。" />
      ) : accounts.length === 0 ? (
        <StatePanel title="还没有可用账号" text="点击“连接账号”，按页面提示选择发布方式。" />
      ) : (
        <div className="mt-5 grid gap-4">
          {accounts.map((account) => (
            <AccountCard
              account={account}
              busy={busyId === account.id}
              key={account.id}
              onAction={runLifecycleAction}
              onEdit={(selected) => {
                setAutomationAccount(null);
                setShowConnect(false);
                setFormError(null);
                setEditingAccount(selected);
                setEditMode(selected.publish_mode);
              }}
              onAutomation={(selected) => {
                setEditingAccount(null);
                setShowConnect(false);
                setAutomationAccount(selected);
              }}
            />
          ))}
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
          时区
          <input
            className={controlClass}
            defaultValue={account.timezone}
            name="timezone"
            required
          />
        </label>
        <div className="sm:col-span-2 lg:col-span-3">
          <DeliveryModeChooser onChange={onModeChange} value={publishMode} />
        </div>
        <label className="text-sm text-ink-700 sm:col-span-2 lg:col-span-3">
          {account.platform_code === 'official_site'
            ? '官网管理后台地址（可选）'
            : '平台发布页面（可选）'}
          <input
            className={controlClass}
            defaultValue={account.publishing_url ?? ''}
            name="publishing_url"
            placeholder="点击“打开发布后台”时跳转到这里"
            type="url"
          />
        </label>
        {publishMode === 'api' && account.platform_code !== 'baijiahao' ? (
          <>
            <label className="text-sm text-ink-700">
              新的发布 API 根地址
              <input
                autoComplete="url"
                className={controlClass}
                name="base_url"
                placeholder="不更换连接可留空"
                type="url"
              />
              <span className="mt-2 block text-xs leading-5 text-ink-500">
                官网示例：https://example.com/api/geo/v1/。这不是后台登录页。
              </span>
            </label>
            <label className="text-sm text-ink-700">
              新的发布令牌
              <input
                autoComplete="new-password"
                className={controlClass}
                name="bearer_token"
                placeholder="不更换连接可留空"
                type="password"
              />
              <span className="mt-2 block text-xs leading-5 text-ink-500">
                由官网运维生成，不是官网后台密码。保存后不会再次显示。
              </span>
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
  onPlatformChange,
  onSubmit,
  platformCode,
  publishMode,
  workspaces,
}: {
  readonly connecting: boolean;
  readonly error: string | null;
  readonly onModeChange: (mode: 'api' | 'export' | 'manual') => void;
  readonly onPlatformChange: (platform: PlatformAccount['platform_code']) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  readonly platformCode: PlatformAccount['platform_code'];
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
        先选平台和发布方式。百家号网关由服务器管理，其他“自动发布”账号需要 API 地址和令牌。
      </p>
      <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
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
        <label className="text-sm text-ink-700">
          平台
          <select
            className={controlClass}
            name="platform_code"
            onChange={(event) =>
              onPlatformChange(event.currentTarget.value as PlatformAccount['platform_code'])
            }
            value={platformCode}
          >
            {PLATFORM_OPTIONS.map(([option, text]) => (
              <option key={option} value={option}>
                {text}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-ink-700">
          账号名称（自己识别用）
          <input
            className={controlClass}
            maxLength={120}
            name="display_name"
            placeholder={`例如：${platformLabel(platformCode)}生产账号`}
            required
          />
        </label>
        <label className="text-sm text-ink-700">
          时区
          <input className={controlClass} defaultValue="Asia/Shanghai" name="timezone" required />
        </label>
        <div className="sm:col-span-2 lg:col-span-3">
          <DeliveryModeChooser onChange={onModeChange} value={publishMode} />
        </div>
        <label className="text-sm text-ink-700 sm:col-span-2 lg:col-span-3">
          {platformCode === 'official_site' ? '官网管理后台地址（可选）' : '平台发布页面（可选）'}
          <input
            className={controlClass}
            name="publishing_url"
            placeholder={
              platformCode === 'official_site'
                ? '例如：https://example.com/admin/news'
                : '不填写时使用系统内置的平台创作页'
            }
            type="url"
          />
          <span className="mt-2 block text-xs leading-5 text-ink-500">
            这里只用于“打开发布后台”，不参与 API 调用。
          </span>
        </label>
        {publishMode === 'api' && platformCode !== 'baijiahao' ? (
          <>
            <label className="text-sm text-ink-700">
              {platformCode === 'official_site' ? '官网发布 API 根地址' : '平台 API 根地址'}
              <input
                autoComplete="url"
                className={controlClass}
                name="base_url"
                placeholder={
                  platformCode === 'official_site'
                    ? 'https://example.com/api/geo/v1/'
                    : 'https://api.example.com/'
                }
                type="url"
              />
              <span className="mt-2 block text-xs leading-5 text-ink-500">
                {platformCode === 'official_site'
                  ? '系统会在该地址下调用 capabilities、media、publish、status 和 metrics。'
                  : '由平台或你的中转服务提供；必须是 HTTPS。'}
              </span>
            </label>
            <label className="text-sm text-ink-700 sm:col-span-2 lg:col-span-1">
              发布令牌
              <input
                autoComplete="new-password"
                className={controlClass}
                name="bearer_token"
                type="password"
              />
              <span className="mt-2 block text-xs leading-5 text-ink-500">
                不是账号密码。令牌由目标系统生成，保存后不会回显。
              </span>
            </label>
          </>
        ) : (
          <input name="base_url" type="hidden" value="" />
        )}
        {publishMode !== 'api' || platformCode === 'baijiahao' ? (
          <input name="bearer_token" type="hidden" value="" />
        ) : null}
      </div>
      <ConnectionGuide mode={publishMode} platformCode={platformCode} />
      <div aria-live="polite" className="mt-4 min-h-6 text-sm text-red-700">
        {error}
      </div>
      <div className="mt-3 flex justify-end">
        <button
          className={primaryButton}
          disabled={connecting || workspaces.length === 0}
          type="submit"
        >
          {connecting ? '正在保存并测试…' : publishMode === 'api' ? '保存并测试连接' : '保存账号'}
        </button>
      </div>
    </form>
  );
}

function DeliveryModeChooser({
  onChange,
  value,
}: {
  readonly onChange: (mode: 'api' | 'export' | 'manual') => void;
  readonly value: 'api' | 'export' | 'manual';
}) {
  const options = [
    {
      description: '质检通过后由系统调用平台接口发布。',
      label: '自动发布',
      value: 'api',
    },
    {
      description: '生成可下载的发布包，再由你上传。',
      label: '导出发布包',
      value: 'export',
    },
    {
      description: '保存平台入口，由你打开后台完成发布。',
      label: '打开后台手动发布',
      value: 'manual',
    },
  ] as const;
  return (
    <fieldset>
      <legend className="text-sm text-ink-700">希望怎样发布</legend>
      <div className="mt-2 grid gap-3 lg:grid-cols-3">
        {options.map((option) => (
          <label
            className={`cursor-pointer rounded-xl border p-4 ${
              value === option.value
                ? 'border-brand-600 bg-brand-50'
                : 'border-line bg-white hover:bg-surface-subtle'
            }`}
            key={option.value}
          >
            <span className="flex items-start gap-3">
              <input
                checked={value === option.value}
                className="mt-1"
                name="publish_mode"
                onChange={() => onChange(option.value)}
                type="radio"
                value={option.value}
              />
              <span>
                <span className="block font-semibold text-ink-900">{option.label}</span>
                <span className="mt-1 block text-xs leading-5 text-ink-500">
                  {option.description}
                </span>
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ConnectionGuide({
  mode,
  platformCode,
}: {
  readonly mode: 'api' | 'export' | 'manual';
  readonly platformCode: PlatformAccount['platform_code'];
}) {
  if (mode === 'export') {
    return (
      <div className="mt-5 rounded-xl bg-surface-subtle p-4 text-sm leading-6 text-ink-700">
        无需填写账号密码或令牌。发布时系统会生成可下载的发布包。
      </div>
    );
  }
  if (mode === 'manual') {
    return (
      <div className="mt-5 rounded-xl bg-surface-subtle p-4 text-sm leading-6 text-ink-700">
        建议填写上方发布页面地址。以后可从账号卡片直接打开该平台后台。
      </div>
    );
  }
  if (platformCode === 'baijiahao') {
    return (
      <div className="mt-5 rounded-xl border border-brand-200 bg-brand-50 p-5 text-sm leading-6 text-ink-700">
        <p className="font-semibold text-ink-900">百家号自动发布使用独立托管浏览器</p>
        <p className="mt-2">
          内部浏览器网关和令牌由服务器环境变量管理，不会发送到前端。账号保存后，在“百家号自动化”中使用二维码登录，不填写百度账号密码。
        </p>
      </div>
    );
  }
  if (platformCode !== 'official_site') {
    return (
      <div className="mt-5 rounded-xl bg-amber-50 p-4 text-sm leading-6 text-amber-900">
        只有平台提供正式发布 API，或你已部署合规的中转服务时才能自动发布。请勿填写平台登录密码。
      </div>
    );
  }
  return (
    <div className="mt-5 rounded-xl border border-brand-200 bg-brand-50 p-5 text-sm leading-6 text-ink-700">
      <p className="font-semibold text-ink-900">官网自动发布需要官网开发或运维提供两项信息</p>
      <ol className="mt-2 list-decimal space-y-1 pl-5">
        <li>API 根地址，例如 https://example.com/api/geo/v1/</li>
        <li>专用发布令牌；它不是官网后台账号密码</li>
      </ol>
      <p className="mt-3 text-xs leading-5 text-ink-500">
        保存时系统会测试 capabilities；配图随文上传使用 media，发布与回查使用 publish、status 和
        metrics。生产环境必须使用 HTTPS，本机联调允许 localhost 或 127.0.0.1。
      </p>
    </div>
  );
}

function AccountCard({
  account,
  busy,
  onAction,
  onAutomation,
  onEdit,
}: {
  readonly account: PlatformAccount;
  readonly busy: boolean;
  readonly onAction: (
    account: PlatformAccount,
    action: 'refresh' | 'test' | 'disable' | 'restore' | 'remove',
  ) => Promise<void>;
  readonly onAutomation: (account: PlatformAccount) => void;
  readonly onEdit: (account: PlatformAccount) => void;
}) {
  const disabled = account.status === 'disabled';
  const publishingUrl = resolvePublishingUrl(account);
  return (
    <article className="rounded-2xl border border-line bg-white p-5 shadow-panel">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-lg font-semibold text-ink-950">
              {platformLabel(account.platform_code)} · {account.display_name}
            </h3>
            <StatusBadge status={account.status} />
          </div>
          <p className="mt-2 text-sm text-ink-600">
            {modeLabel(account.publish_mode)} · {capabilitySummary(account.capabilities)}
          </p>
          <p className="mt-1 text-xs text-ink-500">
            {account.token_expires_at ? `凭证到期：${formatDate(account.token_expires_at)} · ` : ''}
            时区：{account.timezone}
          </p>
        </div>
        {publishingUrl && !disabled ? (
          <a
            className={primarySmallButton}
            href={publishingUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            打开发布后台
          </a>
        ) : null}
      </div>
      <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
        <button
          className={smallButton}
          disabled={busy}
          onClick={() => onEdit(account)}
          type="button"
        >
          修改账号
        </button>
        {account.platform_code === 'official_site' ? (
          <button
            className={smallButton}
            disabled={busy}
            onClick={() => onAutomation(account)}
            type="button"
          >
            官网自动发布
          </button>
        ) : null}
        {account.platform_code === 'baijiahao' && account.publish_mode === 'api' ? (
          <button
            className={smallButton}
            disabled={busy}
            onClick={() => onAutomation(account)}
            type="button"
          >
            百家号自动化
          </button>
        ) : null}
        {account.publish_mode === 'api' && !disabled ? (
          <button
            className={smallButton}
            disabled={busy}
            onClick={() => void onAction(account, 'refresh')}
            type="button"
          >
            重新验证授权
          </button>
        ) : null}
        {!disabled ? (
          <button
            className={smallButton}
            disabled={busy}
            onClick={() => void onAction(account, 'test')}
            type="button"
          >
            测试连接
          </button>
        ) : null}
        {!disabled ? (
          <button
            className={dangerButton}
            disabled={busy}
            onClick={() => void onAction(account, 'disable')}
            type="button"
          >
            停止使用
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
          删除账号
        </button>
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
  ['active', '连接正常'],
  ['reauth', '需要重新连接'],
  ['disabled', '已停止使用'],
] as const;
const ACTION_MESSAGES = {
  disable: '账号已停止使用，不会再用于新发布任务。',
  remove: '账号已删除。',
  refresh: '连接状态已重新验证。',
  restore: '账号已恢复使用。',
  test: '连接测试已完成。',
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
  const text =
    status === 'active' ? '连接正常' : status === 'reauth' ? '需要重新连接' : '已停止使用';
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
  return mode === 'api' ? '自动发布' : mode === 'export' ? '导出发布包' : '手动发布';
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
