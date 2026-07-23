'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import {
  BrandProfileRequestError,
  createBrandProfile,
  getBrandProfile,
  listActiveWorkspaces,
  publishBrandProfile,
} from './brand-profile-api';
import {
  BrandProfileFormSchema,
  type BrandProfileForm,
  type BrandProfileView,
  type WorkspaceChoice,
} from './brand-profile.schema';

const MANAGER_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'strategy_editor']);
const EMPTY_FORM: BrandProfileForm = {
  audience: '',
  banned: '',
  compliance: '',
  cta: '',
  differentiators: '',
  positioning: '',
  tone: '',
  workspace_id: '',
};

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'permission' }
  | { readonly status: 'error' }
  | {
      readonly profile: BrandProfileView | null;
      readonly status: 'ready';
      readonly workspaces: WorkspaceChoice[];
    };

export function BrandProfileEditor() {
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' });
  const [savedProfile, setSavedProfile] = useState<BrandProfileView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
    reset,
    setError,
  } = useForm<BrandProfileForm>({ defaultValues: EMPTY_FORM });

  useEffect(() => {
    const controller = new AbortController();
    void loadEditor(controller.signal);
    return () => controller.abort();

    async function loadEditor(signal: AbortSignal) {
      try {
        const tenants = await listAvailableTenants(signal);
        const role = tenants.find((tenant) => tenant.is_active)?.role_code;
        if (!role || !MANAGER_ROLES.has(role)) {
          setLoadState({ status: 'permission' });
          return;
        }
        const workspaces = await listActiveWorkspaces(signal);
        const id = new URLSearchParams(window.location.search).get('id');
        const profile = id ? await getBrandProfile(id, signal) : null;
        if (signal.aborted) return;
        setSavedProfile(profile?.status === 'draft' ? profile : null);
        setLoadState({ profile, status: 'ready', workspaces });
        reset(profile ? toForm(profile) : { ...EMPTY_FORM, workspace_id: workspaces[0]?.id ?? '' });
      } catch (error) {
        if (signal.aborted) return;
        setLoadState({
          status:
            error instanceof BrandProfileRequestError && error.status === 403
              ? 'permission'
              : 'error',
        });
      }
    }
  }, [reset]);

  if (loadState.status === 'loading') return <EditorSkeleton />;
  if (loadState.status === 'permission')
    return (
      <StatePanel
        title="无权编辑品牌策略"
        text="该页面仅对策略编辑、企业管理员和企业所有者开放。"
      />
    );
  if (loadState.status === 'error')
    return <StatePanel title="无法加载品牌策略" text="请刷新页面后重试。" />;
  if (loadState.workspaces.length === 0)
    return <StatePanel title="暂无可用工作区" text="请先创建或恢复一个 active 工作区。" />;

  const workspaces = loadState.workspaces;
  const sourceProfile = loadState.profile;
  const isReadOnly = sourceProfile?.status === 'published' || sourceProfile?.status === 'retired';

  const save = handleSubmit(async (values) => {
    setMessage(null);
    const parsed = BrandProfileFormSchema.safeParse(values);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (typeof field === 'string' && field in EMPTY_FORM) {
          setError(field as keyof BrandProfileForm, { message: issue.message });
        }
      }
      return;
    }
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    try {
      const created = await createBrandProfile(parsed.data, csrf);
      setSavedProfile(created);
      window.history.replaceState(null, '', `/str-02?id=${created.id}`);
      setMessage(`草稿版本 v${created.version} 已保存。`);
    } catch {
      setMessage('草稿保存失败，请检查权限或稍后重试。');
    }
  });

  async function publish() {
    if (!savedProfile || isPublishing) return;
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    setIsPublishing(true);
    setMessage(null);
    try {
      const published = await publishBrandProfile(savedProfile, csrf);
      setSavedProfile(null);
      setLoadState({ profile: published, status: 'ready', workspaces });
      setMessage(`版本 v${published.version} 已发布。`);
    } catch {
      setMessage('发布失败，版本可能已变化，请刷新后重试。');
    } finally {
      setIsPublishing(false);
    }
  }

  return (
    <form
      className="rounded-2xl border border-line bg-white p-5 shadow-panel sm:p-8"
      noValidate
      onSubmit={save}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-5">
        <div>
          <h2 className="text-xl font-semibold text-ink-950">
            {sourceProfile ? `策略版本 v${sourceProfile.version}` : '新建品牌策略'}
          </h2>
          <p className="mt-1 text-sm text-ink-500">
            {isReadOnly ? '该版本已冻结，只可查看。' : '保存会产生新的不可变草稿版本。'}
          </p>
        </div>
        {sourceProfile ? <StatusBadge status={sourceProfile.status} /> : null}
      </div>

      <fieldset
        className="mt-6 grid gap-5 sm:grid-cols-2"
        disabled={isReadOnly || isSubmitting || isPublishing}
      >
        <Field error={errors.workspace_id?.message} label="工作区" name="brand-workspace">
          <select className={controlClass} id="brand-workspace" {...register('workspace_id')}>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </Field>
        <Field error={errors.tone?.message} label="品牌语气" name="brand-tone">
          <input className={controlClass} id="brand-tone" {...register('tone')} />
        </Field>
        <div className="sm:col-span-2">
          <Field error={errors.positioning?.message} label="品牌定位" name="brand-positioning">
            <textarea
              className={`${controlClass} min-h-28 py-3`}
              id="brand-positioning"
              {...register('positioning')}
            />
          </Field>
        </div>
        <ListField
          error={errors.audience?.message}
          label="目标受众（每行一项）"
          name="brand-audience"
          registration={register('audience')}
        />
        <ListField
          label="差异点（每行一项）"
          name="brand-differentiators"
          registration={register('differentiators')}
        />
        <ListField
          label="禁用词（每行一项）"
          name="brand-banned"
          registration={register('banned')}
        />
        <ListField
          label="合规要求（每行一项）"
          name="brand-compliance"
          registration={register('compliance')}
        />
        <div className="sm:col-span-2">
          <Field error={errors.cta?.message} label="CTA" name="brand-cta">
            <input className={controlClass} id="brand-cta" {...register('cta')} />
          </Field>
        </div>
      </fieldset>

      <div aria-live="polite" className="mt-6 min-h-10">
        {message ? (
          <p className="rounded-control bg-brand-50 px-3 py-2 text-sm text-brand-700" role="status">
            {message}
          </p>
        ) : null}
      </div>

      {!isReadOnly ? (
        <div className="mt-3 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            className="h-11 rounded-control border border-brand-600 px-5 text-sm font-semibold text-brand-700 disabled:opacity-60"
            disabled={!savedProfile || isSubmitting || isPublishing}
            onClick={() => void publish()}
            type="button"
          >
            {isPublishing ? '正在发布…' : '发布新版本'}
          </button>
          <button
            className="h-11 rounded-control bg-brand-600 px-5 text-sm font-semibold text-white disabled:opacity-60"
            disabled={isSubmitting || isPublishing}
            type="submit"
          >
            {isSubmitting ? '正在保存…' : sourceProfile ? '另存为新草稿版本' : '保存草稿'}
          </button>
        </div>
      ) : null}
    </form>
  );
}

const controlClass =
  'mt-2 block h-11 w-full rounded-control border border-line bg-white px-3 text-sm text-ink-950 focus:border-brand-500 focus:outline-none disabled:bg-surface-subtle';

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

function ListField({
  error,
  label,
  name,
  registration,
}: {
  error?: string | undefined;
  label: string;
  name: string;
  registration: ReturnType<ReturnType<typeof useForm<BrandProfileForm>>['register']>;
}) {
  return (
    <Field error={error} label={label} name={name}>
      <textarea className={`${controlClass} min-h-32 py-3`} id={name} {...registration} />
    </Field>
  );
}

function StatusBadge({ status }: { status: BrandProfileView['status'] }) {
  const labels = { draft: '草稿', published: '已发布', retired: '已退役' } as const;
  return (
    <span className="rounded-full bg-brand-50 px-3 py-1 text-sm font-semibold text-brand-700">
      {labels[status]}
    </span>
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
      aria-label="正在加载品牌策略"
      className="h-[34rem] animate-pulse rounded-2xl border border-line bg-white"
    />
  );
}

function toForm(profile: BrandProfileView): BrandProfileForm {
  return {
    audience: profile.profile.audience.join('\n'),
    banned: profile.profile.banned.join('\n'),
    compliance: profile.profile.compliance.join('\n'),
    cta: profile.profile.cta ?? '',
    differentiators: profile.profile.differentiators.join('\n'),
    positioning: profile.profile.positioning,
    tone: profile.profile.tone,
    workspace_id: profile.workspace_id,
  };
}

function readCookie(name: string): string {
  const prefix = `${encodeURIComponent(name)}=`;
  const cookie = document.cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : '';
}
