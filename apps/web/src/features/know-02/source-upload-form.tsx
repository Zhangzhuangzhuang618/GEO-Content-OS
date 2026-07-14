'use client';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import { listActiveWorkspaces } from '../str-02/brand-profile-api';
import { listProjects, uploadSource, UploadRequestError } from './source-upload-api';
import {
  UploadFormSchema,
  type ProjectChoice,
  type UploadForm,
  type UploadResult,
} from './source-upload.schema';
const MANAGER_ROLES = new Set<TenantRole>([
  'tenant_owner',
  'tenant_admin',
  'strategy_editor',
  'content_editor',
]);
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const ALLOWED_TYPES = new Map([
  ['pdf', 'application/pdf'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['txt', 'text/plain'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
]);
export function SourceUploadForm() {
  const [mode, setMode] = useState<'file' | 'url'>('file');
  const [file, setFile] = useState<File | null>(null);
  const [projects, setProjects] = useState<ProjectChoice[]>([]);
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'permission' | 'error'>('loading');
  const [result, setResult] = useState<UploadResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
    reset,
    setError,
    watch,
  } = useForm<UploadForm>({
    defaultValues: {
      effective_from: '',
      effective_to: '',
      language: 'zh-CN',
      project_id: '',
      title: '',
      trust_level: 'normal',
      url: '',
      workspace_id: '',
    },
  });
  const workspaceId = watch('workspace_id');
  useEffect(() => setMode(readMode()), []);
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
        const available = await listActiveWorkspaces(controller.signal);
        setWorkspaces(available);
        reset((current) => ({ ...current, workspace_id: available[0]?.id ?? '' }));
        setState('ready');
      } catch {
        if (!controller.signal.aborted) setState('error');
      }
    })();
    return () => controller.abort();
  }, [reset]);
  useEffect(() => {
    if (!workspaceId) {
      setProjects([]);
      return;
    }
    const controller = new AbortController();
    void listProjects(workspaceId, controller.signal)
      .then(setProjects)
      .catch(() => {
        if (!controller.signal.aborted) setMessage('无法加载项目列表。');
      });
    return () => controller.abort();
  }, [workspaceId]);
  function changeMode(next: 'file' | 'url') {
    setMode(next);
    setFile(null);
    setResult(null);
    setMessage(null);
    window.history.replaceState(null, '', `/know-02?mode=${next}`);
  }
  const submit = handleSubmit(async (values) => {
    setMessage(null);
    setResult(null);
    const parsed = UploadFormSchema.safeParse(values);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (typeof field === 'string')
          setError(field as keyof UploadForm, { message: issue.message });
      }
      return;
    }
    if (mode === 'file') {
      const fileError = validateFile(file);
      if (fileError) {
        setMessage(fileError);
        return;
      }
    } else {
      try {
        const url = new URL(parsed.data.url);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      } catch {
        setError('url', { message: '请输入有效的 HTTP(S) URL。' });
        return;
      }
    }
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    try {
      const uploaded = await uploadSource({ file, form: parsed.data, mode }, csrf);
      setResult(uploaded);
      setMessage('资料已提交，安全扫描与解析任务已创建。');
    } catch (error) {
      setMessage(
        error instanceof UploadRequestError && error.status === 422
          ? '文件类型、大小、病毒或 URL 安全校验未通过。'
          : '上传失败，请检查权限或稍后重试。',
      );
    }
  });
  if (state === 'loading') return <Panel title="正在加载上传表单" text="请稍候。" />;
  if (state === 'permission')
    return <Panel title="无权上传资料" text="该页面仅对策略编辑、内容编辑和租户管理员开放。" />;
  if (state === 'error') return <Panel title="无法加载上传表单" text="请刷新页面后重试。" />;
  if (workspaces.length === 0)
    return <Panel title="暂无可用工作区" text="请先创建 active 工作区。" />;
  return (
    <form
      className="mt-8 rounded-2xl border border-line bg-white p-5 shadow-panel sm:p-8"
      noValidate
      onSubmit={submit}
    >
      <div
        className="grid grid-cols-2 rounded-control bg-surface-subtle p-1"
        role="group"
        aria-label="资料来源"
      >
        <button
          className={mode === 'file' ? activeTab : tab}
          onClick={() => changeMode('file')}
          type="button"
        >
          上传文件
        </button>
        <button
          className={mode === 'url' ? activeTab : tab}
          onClick={() => changeMode('url')}
          type="button"
        >
          登记 URL
        </button>
      </div>
      <div className="mt-6 grid gap-5 sm:grid-cols-2">
        <Field error={errors.title?.message} label="标题" name="source-title">
          <input className={controlClass} id="source-title" {...register('title')} />
        </Field>
        <Field error={errors.language?.message} label="语言" name="source-language">
          <input
            className={controlClass}
            id="source-language"
            placeholder="zh-CN"
            {...register('language')}
          />
        </Field>
        <Field label="工作区" name="source-workspace">
          <select className={controlClass} id="source-workspace" {...register('workspace_id')}>
            {workspaces.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="项目（可选）" name="source-project">
          <select className={controlClass} id="source-project" {...register('project_id')}>
            <option value="">不指定项目</option>
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="可信级别" name="source-trust">
          <select className={controlClass} id="source-trust" {...register('trust_level')}>
            <option value="verified">已验证</option>
            <option value="normal">普通</option>
            <option value="untrusted">不可信</option>
          </select>
        </Field>
        <div />
        <Field label="有效期开始" name="source-from">
          <input
            className={controlClass}
            id="source-from"
            type="date"
            {...register('effective_from')}
          />
        </Field>
        <Field error={errors.effective_to?.message} label="有效期结束" name="source-to">
          <input
            className={controlClass}
            id="source-to"
            type="date"
            {...register('effective_to')}
          />
        </Field>
        <div className="sm:col-span-2">
          {mode === 'file' ? (
            <Field label="文件" name="source-file">
              <input
                accept=".pdf,.docx,.txt,.png,.jpg,.jpeg,.webp"
                className={`${controlClass} py-2`}
                id="source-file"
                onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
                type="file"
              />
              <p className="mt-2 text-xs text-ink-500">
                PDF、DOCX、TXT、PNG、JPEG、WebP；默认最大 25
                MiB。服务端会复核内容签名并执行安全扫描。
              </p>
            </Field>
          ) : (
            <Field error={errors.url?.message} label="URL" name="source-url">
              <input
                className={controlClass}
                id="source-url"
                placeholder="https://example.com/document"
                type="url"
                {...register('url')}
              />
              <p className="mt-2 text-xs text-ink-500">
                服务端会检查 DNS、私网地址、重定向、响应大小和超时。
              </p>
            </Field>
          )}
        </div>
      </div>
      <div aria-live="polite" className="mt-6 min-h-12">
        {message ? (
          <p className="rounded-control bg-brand-50 px-3 py-2 text-sm text-brand-700" role="status">
            {message}
          </p>
        ) : null}
      </div>
      {result ? (
        <div className="mt-3 rounded-control border border-brand-100 bg-brand-50 p-4 text-sm text-brand-700">
          <p>资料：{result.source.title}</p>
          <p className="mt-1">
            解析任务：{result.ingest_job.id}（{result.ingest_job.status}）
          </p>
          <a
            className="mt-3 inline-flex font-semibold underline"
            href={`/know-03?id=${result.source.id}`}
          >
            查看资料详情
          </a>
        </div>
      ) : null}
      <button
        className="mt-5 h-11 w-full rounded-control bg-brand-600 px-5 text-sm font-semibold text-white disabled:opacity-60"
        disabled={isSubmitting}
        type="submit"
      >
        {isSubmitting ? '正在提交…' : '上传并创建解析任务'}
      </button>
    </form>
  );
}
function validateFile(file: File | null) {
  if (!file) return '请选择文件。';
  if (file.size === 0) return '文件不能为空。';
  if (file.size > MAX_FILE_BYTES) return '文件超过默认 25 MiB 上限。';
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (!extension || ALLOWED_TYPES.get(extension) !== file.type)
    return '文件扩展名与 MIME 类型必须匹配允许格式。';
  return null;
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
function Panel({ text, title }: { text: string; title: string }) {
  return (
    <section className="mt-8 rounded-2xl border border-line bg-white p-8 text-center shadow-panel">
      <h2 className="text-xl font-semibold text-ink-950">{title}</h2>
      <p className="mt-3 text-sm text-ink-500">{text}</p>
    </section>
  );
}
function readMode() {
  if (typeof window === 'undefined') return 'file';
  return new URLSearchParams(window.location.search).get('mode') === 'url' ? 'url' : 'file';
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
  'mt-2 block h-11 w-full rounded-control border border-line bg-white px-3 text-sm text-ink-950 focus:border-brand-500 focus:outline-none';
const tab = 'h-10 rounded-control text-sm font-semibold text-ink-500';
const activeTab = 'h-10 rounded-control bg-white text-sm font-semibold text-brand-700 shadow-sm';
