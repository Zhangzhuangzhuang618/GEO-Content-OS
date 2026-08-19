'use client';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import { TechnicalDetails } from '../human-readable';
import { listActiveWorkspaces } from '../str-02/brand-profile-api';
import { BatchUrlImport } from './batch-url-import';
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
const MAX_CERTIFICATE_IMAGE_BYTES = 10_000_000;
const ALLOWED_TYPES = new Map([
  ['pdf', 'application/pdf'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['txt', 'text/plain'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
]);
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
export function SourceUploadForm() {
  const [mode, setMode] = useState<'batch-url' | 'file' | 'url'>('file');
  const [file, setFile] = useState<File | null>(null);
  const [projects, setProjects] = useState<ProjectChoice[]>([]);
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'permission' | 'error'>('loading');
  const [result, setResult] = useState<UploadResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    getValues,
    register,
    reset,
    setError,
    setValue,
    watch,
  } = useForm<UploadForm>({
    defaultValues: {
      article_use_allowed: false,
      certificate_name: '',
      certificate_number: '',
      effective_from: '',
      effective_to: '',
      holder_name: '',
      insurance_type: '',
      insured_count: '',
      insurer_name: '',
      issuing_authority: '',
      language: 'zh-CN',
      material_kind: 'document',
      policyholder_name: '',
      project_id: '',
      public_display_confirmed: false,
      summary_use_confirmed: false,
      title: '',
      trust_level: 'normal',
      url: '',
      verification_url: '',
      workspace_id: '',
    },
  });
  const workspaceId = watch('workspace_id');
  const certificateMaterial = watch('material_kind') === 'certificate';
  const insuranceProofMaterial = watch('material_kind') === 'insurance_proof';
  const articleUseAllowed = watch('article_use_allowed');
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
  function changeMode(next: 'batch-url' | 'file' | 'url') {
    setMode(next);
    setFile(null);
    setResult(null);
    setMessage(null);
    setValue('material_kind', 'document');
    window.history.replaceState(null, '', `/know-02?mode=${next}`);
  }
  const submit = handleSubmit(async (values) => {
    if (mode === 'batch-url') return;
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
      const fileError = validateFile(file, parsed.data.material_kind);
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
    return <Panel title="无权上传资料" text="该页面仅对策略编辑、内容编辑和企业管理员开放。" />;
  if (state === 'error') return <Panel title="无法加载上传表单" text="请刷新页面后重试。" />;
  if (workspaces.length === 0)
    return <Panel title="暂无可用工作区" text="请先创建 active 工作区。" />;
  return (
    <form
      className="mt-8 rounded-2xl border border-line bg-white p-5 shadow-panel sm:p-8"
      noValidate
      onSubmit={mode === 'batch-url' ? (event) => event.preventDefault() : submit}
    >
      <div
        className="grid grid-cols-3 rounded-control bg-surface-subtle p-1"
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
        <button
          className={mode === 'batch-url' ? activeTab : tab}
          onClick={() => changeMode('batch-url')}
          type="button"
        >
          批量导入 URL
        </button>
      </div>
      <div className="mt-6 grid gap-5 sm:grid-cols-2">
        {mode !== 'batch-url' ? (
          <Field error={errors.title?.message} label="标题" name="source-title">
            <input
              className={controlClass}
              id="source-title"
              readOnly={insuranceProofMaterial}
              {...register('title')}
            />
            {insuranceProofMaterial ? (
              <p className="mt-1 text-xs text-ink-500">
                保险证明标题固定为“企业保险证明”，避免文件名或保单编号进入检索。
              </p>
            ) : null}
          </Field>
        ) : null}
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
        <Field error={errors.effective_from?.message} label="有效期开始" name="source-from">
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
        {mode !== 'batch-url' ? (
          <div className="sm:col-span-2">
            {mode === 'file' ? (
              <>
                <Field label="文件" name="source-file">
                  <input
                    accept=".pdf,.docx,.txt,.png,.jpg,.jpeg,.webp"
                    className={`${controlClass} py-2`}
                    id="source-file"
                    onChange={(event) => {
                      const selected = event.currentTarget.files?.[0] ?? null;
                      setFile(selected);
                      const currentKind = getValues('material_kind');
                      setValue(
                        'material_kind',
                        selected && IMAGE_TYPES.has(selected.type)
                          ? 'certificate'
                          : selected?.type === 'application/pdf' &&
                              currentKind === 'insurance_proof'
                            ? 'insurance_proof'
                            : 'document',
                      );
                    }}
                    type="file"
                  />
                  <p className="mt-2 text-xs text-ink-500">
                    支持 PDF、DOCX、TXT 及 PNG、JPEG、WebP 企业证照，默认最大 25
                    MiB。服务端会复核内容签名并执行安全扫描。
                  </p>
                  <p className="mt-1 text-xs text-ink-500">
                    资料图片需可正常打开、至少 768×512 像素、最长边不超过 8192 像素、总像素不超过
                    5000 万；证照不超过 10 MB，其他图片沿用 25 MiB
                    上限。证照获授权并随文发布时会自动等比缩图。
                  </p>
                </Field>
                <div className="mt-5">
                  <Field label="资料类型" name="source-material-kind">
                    <select
                      className={controlClass}
                      id="source-material-kind"
                      {...register('material_kind', {
                        onChange: (event) => {
                          if (event.target.value === 'insurance_proof') {
                            setValue('trust_level', 'verified');
                            setValue('title', '企业保险证明', { shouldValidate: true });
                          }
                        },
                      })}
                    >
                      <option value="document">普通文档</option>
                      <option value="certificate">企业证照图片</option>
                      <option value="insurance_proof">保险证明 PDF</option>
                    </select>
                  </Field>
                </div>
                {certificateMaterial ? (
                  <section className="mt-5 rounded-xl border border-line bg-surface-subtle p-4">
                    <h3 className="font-semibold text-ink-950">证照核验信息</h3>
                    <p className="mt-2 text-xs leading-5 text-ink-500">
                      当前生产环境不会自动
                      OCR。以下人工确认字段会作为可检索事实；原图保持私有，只有正文引用且获得公开授权时才生成随文副本。
                    </p>
                    <div className="mt-4 grid gap-4 sm:grid-cols-2">
                      <Field
                        error={errors.certificate_name?.message}
                        label="证照名称"
                        name="certificate-name"
                      >
                        <input
                          className={controlClass}
                          id="certificate-name"
                          {...register('certificate_name')}
                        />
                      </Field>
                      <Field
                        error={errors.certificate_number?.message}
                        label="证照编号"
                        name="certificate-number"
                      >
                        <input
                          className={controlClass}
                          id="certificate-number"
                          {...register('certificate_number')}
                        />
                      </Field>
                      <Field
                        error={errors.holder_name?.message}
                        label="持证主体"
                        name="certificate-holder"
                      >
                        <input
                          className={controlClass}
                          id="certificate-holder"
                          {...register('holder_name')}
                        />
                      </Field>
                      <Field
                        error={errors.issuing_authority?.message}
                        label="发证机关"
                        name="certificate-authority"
                      >
                        <input
                          className={controlClass}
                          id="certificate-authority"
                          {...register('issuing_authority')}
                        />
                      </Field>
                      <div className="sm:col-span-2">
                        <Field
                          error={errors.verification_url?.message}
                          label="官方核验链接（可选）"
                          name="certificate-verification-url"
                        >
                          <input
                            className={controlClass}
                            id="certificate-verification-url"
                            placeholder="https://..."
                            type="url"
                            {...register('verification_url')}
                          />
                        </Field>
                      </div>
                    </div>
                    <label className="mt-5 flex items-start gap-3 text-sm text-ink-700">
                      <input
                        className="mt-1"
                        type="checkbox"
                        {...register('article_use_allowed')}
                      />
                      <span>允许文章在实际引用这份证照时展示发布副本。</span>
                    </label>
                    {articleUseAllowed ? (
                      <label className="mt-3 flex items-start gap-3 text-sm text-ink-700">
                        <input
                          className="mt-1"
                          type="checkbox"
                          {...register('public_display_confirmed')}
                        />
                        <span>
                          我确认有权公开该证照，且图片不含无关个人证件号、银行卡或私人联系方式。证照编号、持证主体、发证机关和有效期将保留用于核验。
                        </span>
                      </label>
                    ) : null}
                    {errors.public_display_confirmed?.message ? (
                      <p className="mt-2 text-sm text-red-700">
                        {errors.public_display_confirmed.message}
                      </p>
                    ) : null}
                  </section>
                ) : null}
                {insuranceProofMaterial ? (
                  <section className="mt-5 rounded-xl border border-line bg-surface-subtle p-4">
                    <h3 className="font-semibold text-ink-950">保险证明脱敏摘要</h3>
                    <p className="mt-2 text-xs leading-5 text-ink-500">
                      仅接受 PDF。系统私有保存原件，不执行
                      OCR，也不会索引人员名单、证件号、电话、保单号或原始正文；只有以下人工确认字段生成的脱敏摘要可参与检索和生文。
                    </p>
                    <div className="mt-4 grid gap-4 sm:grid-cols-2">
                      <Field
                        error={errors.policyholder_name?.message}
                        label="投保主体"
                        name="insurance-policyholder"
                      >
                        <input
                          className={controlClass}
                          id="insurance-policyholder"
                          {...register('policyholder_name')}
                        />
                      </Field>
                      <Field
                        error={errors.insurer_name?.message}
                        label="承保机构"
                        name="insurance-insurer"
                      >
                        <input
                          className={controlClass}
                          id="insurance-insurer"
                          {...register('insurer_name')}
                        />
                      </Field>
                      <Field
                        error={errors.insurance_type?.message}
                        label="保险类型"
                        name="insurance-type"
                      >
                        <input
                          className={controlClass}
                          id="insurance-type"
                          {...register('insurance_type')}
                        />
                      </Field>
                      <Field
                        error={errors.insured_count?.message}
                        label="参保人数"
                        name="insurance-insured-count"
                      >
                        <input
                          className={controlClass}
                          id="insurance-insured-count"
                          inputMode="numeric"
                          min="1"
                          max="100000"
                          type="number"
                          {...register('insured_count')}
                        />
                      </Field>
                    </div>
                    <label className="mt-5 flex items-start gap-3 text-sm text-ink-700">
                      <input
                        className="mt-1"
                        type="checkbox"
                        {...register('summary_use_confirmed')}
                      />
                      <span>
                        我确认上述字段不含个人信息，并只允许系统生成的脱敏摘要参与检索和生文；保险原件不得公开或作为文章图片。
                      </span>
                    </label>
                    {errors.summary_use_confirmed?.message ? (
                      <p className="mt-2 text-sm text-red-700">
                        {errors.summary_use_confirmed.message}
                      </p>
                    ) : null}
                  </section>
                ) : null}
              </>
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
        ) : null}
      </div>
      {mode === 'batch-url' ? (
        <BatchUrlImport
          getCsrf={() => readCookie('geo_csrf')}
          getForm={getValues}
          onMessage={setMessage}
        />
      ) : null}
      <div aria-live="polite" className="mt-6 min-h-12">
        {message ? (
          <p className="rounded-control bg-brand-50 px-3 py-2 text-sm text-brand-700" role="status">
            {message}
          </p>
        ) : null}
      </div>
      {result && mode !== 'batch-url' ? (
        <div className="mt-3 rounded-control border border-brand-100 bg-brand-50 p-4 text-sm text-brand-700">
          <p className="font-semibold">资料“{result.source.title}”已提交</p>
          <p className="mt-1">当前进度：{ingestStatusLabel(result.ingest_job.status)}</p>
          <a
            className="mt-3 inline-flex font-semibold underline"
            href={`/know-03?id=${result.source.id}&workspace_id=${result.source.workspace_id}&project_id=${result.source.project_id ?? projects[0]?.id ?? ''}`}
          >
            查看资料详情
          </a>
          <div className="mt-3 text-ink-500">
            <TechnicalDetails summary="处理技术信息">
              <p>资料编号：{result.source.id}</p>
              <p>处理记录：{result.ingest_job.id}</p>
            </TechnicalDetails>
          </div>
        </div>
      ) : null}
      {mode !== 'batch-url' ? (
        <button
          className="mt-5 h-11 w-full rounded-control bg-brand-600 px-5 text-sm font-semibold text-white disabled:opacity-60"
          disabled={isSubmitting}
          type="submit"
        >
          {isSubmitting ? '正在提交…' : '上传并创建解析任务'}
        </button>
      ) : null}
    </form>
  );
}
function ingestStatusLabel(status: string) {
  return (
    {
      failed: '处理失败，可进入详情重试',
      queued: '等待处理',
      running: '正在整理资料',
      succeeded: '处理完成',
    }[status] ?? '处理中'
  );
}
function validateFile(file: File | null, materialKind: UploadForm['material_kind']) {
  if (!file) return '请选择文件。';
  if (file.size === 0) return '文件不能为空。';
  if (file.size > MAX_FILE_BYTES) return '文件超过默认 25 MiB 上限。';
  if (IMAGE_TYPES.has(file.type) && file.size > MAX_CERTIFICATE_IMAGE_BYTES)
    return '证照图片超过 10 MB 上限。';
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (!extension || ALLOWED_TYPES.get(extension) !== file.type)
    return '文件扩展名与 MIME 类型必须匹配允许格式。';
  if (materialKind === 'certificate' && !IMAGE_TYPES.has(file.type))
    return '企业证照必须上传 PNG、JPEG 或 WebP 图片。';
  if (materialKind === 'insurance_proof' && file.type !== 'application/pdf')
    return '保险证明必须上传 PDF 文件。';
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
  const mode = new URLSearchParams(window.location.search).get('mode');
  return mode === 'url' || mode === 'batch-url' ? mode : 'file';
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
