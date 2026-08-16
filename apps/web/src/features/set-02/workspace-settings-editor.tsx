'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import {
  archiveWorkspace,
  listWorkspaces,
  updateWorkspace,
  WorkspaceRequestError,
} from './workspace-settings-api';
import {
  WorkspaceFormSchema,
  type PlatformCode,
  type Workspace,
  type WorkspaceForm,
} from './workspace-settings.schema';

const MANAGER_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin']);
const PLATFORMS: readonly [PlatformCode, string][] = [
  ['official_site', '官网'],
  ['baijiahao', '百家号'],
  ['sohu', '搜狐号'],
  ['lieju', '列举网'],
  ['toutiao', '头条号'],
  ['zhihu', '知乎'],
  ['xiaohongshu', '小红书'],
  ['wechat_mp', '微信公众号'],
  ['douyin', '抖音'],
];

export function WorkspaceSettingsEditor() {
  const [items, setItems] = useState<Workspace[]>([]);
  const [selected, setSelected] = useState<Workspace | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'permission' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [isArchiving, setIsArchiving] = useState(false);
  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
    reset,
    setError,
  } = useForm<WorkspaceForm>({ defaultValues: emptyForm() });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const tenants = await listAvailableTenants(controller.signal);
        const role = tenants.find((tenant) => tenant.is_active)?.role_code;
        if (!role || !MANAGER_ROLES.has(role)) {
          setState('permission');
          return;
        }
        const workspaces = await listWorkspaces(controller.signal);
        if (controller.signal.aborted) return;
        const requestedId = new URLSearchParams(window.location.search).get('id');
        const current = workspaces.find((item) => item.id === requestedId) ?? workspaces[0] ?? null;
        setItems(workspaces);
        setSelected(current);
        if (current) {
          reset(toForm(current));
          writeSelection(current.id);
        }
        setState('ready');
      } catch (error) {
        if (controller.signal.aborted) return;
        setState(
          error instanceof WorkspaceRequestError && error.status === 403 ? 'permission' : 'error',
        );
      }
    })();
    return () => controller.abort();
  }, [reset]);

  function selectWorkspace(id: string) {
    const workspace = items.find((item) => item.id === id) ?? null;
    setSelected(workspace);
    setMessage(null);
    if (workspace) {
      reset(toForm(workspace));
      writeSelection(workspace.id);
    }
  }

  const save = handleSubmit(async (values) => {
    if (!selected) return;
    setMessage(null);
    const parsed = WorkspaceFormSchema.safeParse(values);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (typeof field === 'string')
          setError(field as keyof WorkspaceForm, { message: issue.message });
      }
      return;
    }
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    try {
      const updated = await updateWorkspace(selected, parsed.data, csrf);
      replaceWorkspace(updated);
      reset(toForm(updated));
      setMessage(`工作区已保存，当前版本 v${updated.version}。`);
    } catch {
      setMessage('保存失败，工作区版本或字段可能已变化，请刷新后重试。');
    }
  });

  async function archive() {
    if (!selected || selected.status !== 'active' || activeCount(items) <= 1) return;
    const reason = window.prompt('归档原因（必填）')?.trim();
    if (!reason) return;
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    setIsArchiving(true);
    setMessage(null);
    try {
      const archived = await archiveWorkspace(selected, reason, csrf);
      replaceWorkspace(archived);
      reset(toForm(archived));
      setMessage('工作区已归档。');
    } catch {
      setMessage('归档失败；企业必须至少保留一个正常使用的工作区。');
    } finally {
      setIsArchiving(false);
    }
  }

  function replaceWorkspace(workspace: Workspace) {
    setItems((current) => current.map((item) => (item.id === workspace.id ? workspace : item)));
    setSelected(workspace);
  }

  if (state === 'loading') return <EditorSkeleton />;
  if (state === 'permission')
    return <StatePanel title="无权管理工作区" text="该页面仅对企业所有者和企业管理员开放。" />;
  if (state === 'error')
    return <StatePanel title="无法加载工作区" text="请检查网络或权限后刷新页面。" />;
  if (!selected) return <StatePanel title="暂无工作区" text="当前企业尚未创建工作区。" />;

  const readOnly = selected.status === 'archived';
  const lastActive = selected.status === 'active' && activeCount(items) <= 1;

  return (
    <div className="grid gap-5 lg:grid-cols-[16rem_1fr]">
      <aside className="rounded-2xl border border-line bg-white p-3 shadow-panel">
        <label className="text-sm font-medium text-ink-700" htmlFor="workspace-selection">
          当前工作区
        </label>
        <select
          className={controlClass}
          id="workspace-selection"
          onChange={(event) => selectWorkspace(event.currentTarget.value)}
          value={selected.id}
        >
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} {item.status === 'archived' ? '（已归档）' : ''}
            </option>
          ))}
        </select>
        <p className="mt-4 text-xs leading-5 text-ink-500">
          已归档工作区保持只读，不能重新保存或再次归档。
        </p>
      </aside>

      <form
        className="rounded-2xl border border-line bg-white p-5 shadow-panel sm:p-8"
        noValidate
        onSubmit={save}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-5">
          <div>
            <h2 className="text-xl font-semibold text-ink-950">{selected.name}</h2>
            <p className="mt-1 text-sm text-ink-500">版本 v{selected.version}</p>
          </div>
          <StatusBadge status={selected.status} />
        </div>

        <fieldset className="mt-6 grid gap-5 sm:grid-cols-2" disabled={readOnly || isArchiving}>
          <Field error={errors.name?.message} label="名称" name="workspace-name">
            <input className={controlClass} id="workspace-name" {...register('name')} />
          </Field>
          <Field error={errors.slug?.message} label="slug" name="workspace-slug">
            <input className={controlClass} id="workspace-slug" {...register('slug')} />
          </Field>
          <Field error={errors.timezone?.message} label="时区" name="workspace-timezone">
            <input
              className={controlClass}
              id="workspace-timezone"
              placeholder="Asia/Shanghai"
              {...register('timezone')}
            />
          </Field>
          <Field
            error={errors.minimum_approvals?.message}
            label="最低审核人数"
            name="workspace-approvals"
          >
            <select
              className={controlClass}
              id="workspace-approvals"
              {...register('minimum_approvals')}
            >
              {[1, 2, 3, 4, 5].map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
          </Field>
          <div className="sm:col-span-2">
            <fieldset className="rounded-control border border-line p-4">
              <legend className="px-1 text-sm font-medium text-ink-700">默认平台</legend>
              <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {PLATFORMS.map(([code, label]) => (
                  <label className="flex items-center gap-2 text-sm text-ink-700" key={code}>
                    <input type="checkbox" value={code} {...register('default_platform_codes')} />
                    {label}
                  </label>
                ))}
              </div>
              {errors.default_platform_codes?.message ? (
                <p className="mt-2 text-sm text-red-700">{errors.default_platform_codes.message}</p>
              ) : null}
            </fieldset>
          </div>
          <Field
            error={errors.monthly_limit_cny?.message}
            label="月度预算（元，可留空）"
            name="workspace-budget"
          >
            <input
              className={controlClass}
              id="workspace-budget"
              inputMode="decimal"
              {...register('monthly_limit_cny')}
            />
          </Field>
          <div className="space-y-3 pt-7">
            <label className="flex items-center gap-2 text-sm text-ink-700">
              <input type="checkbox" {...register('hard_limit')} />
              达到预算后硬阻断
            </label>
            <label className="flex items-center gap-2 text-sm text-ink-700">
              <input type="checkbox" {...register('require_high_risk_signoff')} />
              高风险内容必须加签
            </label>
          </div>
        </fieldset>

        {lastActive ? (
          <p className="mt-5 text-sm font-medium text-red-700">
            这是最后一个 active 工作区，不能归档。
          </p>
        ) : null}
        {readOnly ? <p className="mt-5 text-sm text-ink-500">已归档工作区只可查看。</p> : null}

        <div aria-live="polite" className="mt-5 min-h-10">
          {message ? (
            <p
              className="rounded-control bg-brand-50 px-3 py-2 text-sm text-brand-700"
              role="status"
            >
              {message}
            </p>
          ) : null}
        </div>

        {!readOnly ? (
          <div className="mt-3 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              className={secondaryButton}
              disabled={lastActive || isSubmitting || isArchiving}
              onClick={() => void archive()}
              type="button"
            >
              {isArchiving ? '正在归档…' : '归档工作区'}
            </button>
            <button className={primaryButton} disabled={isSubmitting || isArchiving} type="submit">
              {isSubmitting ? '正在保存…' : '保存设置'}
            </button>
          </div>
        ) : null}
      </form>
    </div>
  );
}

function toForm(workspace: Workspace): WorkspaceForm {
  return {
    default_platform_codes: workspace.settings.default_platform_codes ?? ['official_site'],
    hard_limit: workspace.settings.budget_policy?.hard_limit ?? false,
    minimum_approvals: String(workspace.settings.review_policy?.minimum_approvals ?? 1),
    monthly_limit_cny:
      workspace.settings.budget_policy?.monthly_limit_cny === null ||
      workspace.settings.budget_policy?.monthly_limit_cny === undefined
        ? ''
        : String(workspace.settings.budget_policy.monthly_limit_cny),
    name: workspace.name,
    require_high_risk_signoff: workspace.settings.review_policy?.require_high_risk_signoff ?? false,
    slug: workspace.slug,
    timezone: workspace.timezone,
  };
}

function emptyForm(): WorkspaceForm {
  return {
    default_platform_codes: ['official_site'],
    hard_limit: false,
    minimum_approvals: '1',
    monthly_limit_cny: '',
    name: '',
    require_high_risk_signoff: false,
    slug: '',
    timezone: 'Asia/Shanghai',
  };
}

function activeCount(items: Workspace[]) {
  return items.filter((item) => item.status === 'active').length;
}

function writeSelection(id: string) {
  window.history.replaceState(null, '', `/set-02?id=${id}`);
}

function StatusBadge({ status }: { status: Workspace['status'] }) {
  return (
    <span className="rounded-full bg-brand-50 px-3 py-1 text-sm font-semibold text-brand-700">
      {status === 'active' ? 'Active' : '已归档'}
    </span>
  );
}

function Field({
  children,
  error,
  label,
  name,
}: {
  children: React.ReactNode;
  error?: string | undefined;
  label: string;
  name: string;
}) {
  return (
    <div>
      <label className="text-sm font-medium text-ink-700" htmlFor={name}>
        {label}
      </label>
      {children}
      {error ? <p className="mt-1 text-sm text-red-700">{error}</p> : null}
    </div>
  );
}

function StatePanel({ text, title }: { text: string; title: string }) {
  return (
    <section className="rounded-2xl border border-line bg-white p-8 text-center shadow-panel">
      <h2 className="text-xl font-semibold text-ink-950">{title}</h2>
      <p className="mt-3 text-sm text-ink-500">{text}</p>
    </section>
  );
}

function EditorSkeleton() {
  return (
    <section
      aria-busy="true"
      aria-label="正在加载工作区设置"
      className="h-[36rem] animate-pulse rounded-2xl bg-surface-subtle"
    />
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
  'h-11 rounded-control border border-line bg-white px-5 text-sm font-semibold text-ink-700 focus:outline-2 focus:outline-offset-2 disabled:opacity-60';
