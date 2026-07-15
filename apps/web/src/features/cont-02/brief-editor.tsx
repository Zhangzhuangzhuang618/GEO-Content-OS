'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import type { Brief, BriefObjective, PlatformCode } from '../cont-01/brief-list.schema';
import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import {
  BriefEditorRequestError,
  createContentPackage,
  getBrief,
  saveBrief,
} from './brief-editor-api';
import { BriefSaveInputSchema, type BriefSaveInput } from './brief-editor.schema';

const EDITOR_ROLES = new Set<TenantRole>([
  'tenant_owner',
  'tenant_admin',
  'strategy_editor',
  'content_editor',
]);
const PACKAGE_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'content_editor']);
const PLATFORMS = [
  ['official_site', '官网'],
  ['baijiahao', '百家号'],
  ['toutiao', '头条号'],
  ['zhihu', '知乎'],
  ['xiaohongshu', '小红书'],
  ['wechat_mp', '微信公众号'],
  ['douyin', '抖音'],
] as const satisfies readonly (readonly [PlatformCode, string])[];

export function BriefEditor() {
  const formRef = useRef<HTMLFormElement>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [copying, setCopying] = useState(false);
  const [canCreatePackage, setCanCreatePackage] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'permission'>('loading');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<CostEstimate | null>(null);
  const [packageId, setPackageId] = useState<string | null>(null);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const id = query.get('id');
    const copyFrom = query.get('copy_from');
    const controller = new AbortController();
    void (async () => {
      try {
        const tenants = await listAvailableTenants(controller.signal);
        const role = tenants.find((tenant) => tenant.is_active)?.role_code;
        if (!role || !EDITOR_ROLES.has(role)) {
          setState('permission');
          return;
        }
        setCanCreatePackage(PACKAGE_ROLES.has(role));
        const sourceId = id ?? copyFrom;
        if (sourceId) {
          const source = await getBrief(sourceId, controller.signal);
          setBrief(copyFrom ? { ...source, title: `${source.title} 副本` } : source);
          setCopying(Boolean(copyFrom));
        }
        setState('ready');
      } catch (error) {
        if (controller.signal.aborted) return;
        setState(isAccessError(error) ? 'permission' : 'error');
      }
    })();
    return () => controller.abort();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseForm(event.currentTarget);
    if (!parsed.success) {
      setMessage(parsed.message);
      return;
    }
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const saved = await saveBrief(parsed.data, csrf, brief && !copying ? brief : undefined);
      setBrief(saved);
      setCopying(false);
      setMessage('Brief 已保存。');
      window.history.replaceState(null, '', `/cont-02?id=${saved.id}`);
    } catch (error) {
      setMessage(
        error instanceof BriefEditorRequestError && error.status === 409
          ? '版本已变化，请刷新后重试。'
          : '保存失败，请检查输入或稍后重试。',
      );
    } finally {
      setBusy(false);
    }
  }

  function estimateCost() {
    const form = formRef.current;
    if (!form) return;
    const parsed = parseForm(form);
    if (!parsed.success) {
      setMessage(parsed.message);
      return;
    }
    setEstimate(buildEstimate(parsed.data));
    setMessage(null);
  }

  async function createPackage() {
    if (!brief || copying) return;
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      setPackageId(await createContentPackage(brief, csrf));
      setMessage('内容包已创建。');
    } catch {
      setMessage('内容包创建失败，请确认 Brief 已保存且当前角色有生产权限。');
    } finally {
      setBusy(false);
    }
  }

  if (state === 'loading')
    return <StatePanel title="正在加载 Brief" text="正在读取权限和表单数据。" />;
  if (state === 'permission')
    return <StatePanel title="无权编辑 Brief" text="需要策略编辑、内容编辑或租户管理员权限。" />;
  if (state === 'error')
    return <StatePanel title="无法加载 Brief" text="资源不存在或网络请求失败。" />;

  return (
    <section className="mt-8">
      {copying ? (
        <p className="mb-4 rounded-control bg-brand-50 p-3 text-sm text-brand-700">
          正在创建副本；保存后会生成新的 Brief ID。
        </p>
      ) : null}
      <form
        className="rounded-2xl border border-line bg-white p-5 shadow-panel"
        key={`${brief?.id ?? 'new'}-${copying}`}
        onSubmit={submit}
        ref={formRef}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField defaultValue={brief?.title} label="标题" name="title" required />
          <SelectField defaultValue={brief?.objective} label="目标" name="objective" />
          <TextField
            defaultValue={brief?.workspace_id}
            label="工作区 UUID"
            name="workspace_id"
            readOnly={Boolean(brief && !copying)}
            required
          />
          <TextField
            defaultValue={brief?.project_id}
            label="项目 UUID"
            name="project_id"
            readOnly={Boolean(brief && !copying)}
            required
          />
          <TextField
            defaultValue={brief?.keyword_ids.join(',')}
            label="关键词 UUID（逗号或换行分隔）"
            name="keyword_ids"
          />
          <TextField
            defaultValue={brief?.primary_keyword_id}
            label="主关键词 UUID"
            name="primary_keyword_id"
          />
          <TextField
            defaultValue={brief?.source_ids.join(',')}
            label="证据来源 UUID（逗号或换行分隔）"
            name="source_ids"
          />
          <TextField
            defaultValue={toLocalDateTime(brief?.due_at)}
            label="截止时间"
            name="due_at"
            type="datetime-local"
          />
        </div>
        <TextArea defaultValue={brief?.audience} label="受众" name="audience" required />
        <fieldset className="mt-5">
          <legend className="text-sm font-medium text-ink-700">目标平台（至少一个）</legend>
          <div className="mt-3 grid gap-2 sm:grid-cols-4">
            {PLATFORMS.map(([code, label]) => (
              <label className="flex items-center gap-2 text-sm" key={code}>
                <input
                  defaultChecked={brief?.platform_codes.includes(code) ?? code === 'official_site'}
                  name="platform_codes"
                  type="checkbox"
                  value={code}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <TextArea
          defaultValue={brief?.constraints.additional_instructions ?? ''}
          label="附加约束"
          name="additional_instructions"
        />
        <TextArea defaultValue={brief?.constraints.cta ?? ''} label="CTA" name="cta" />
        <div className="mt-6 flex flex-wrap gap-3">
          <button className={primaryButton} disabled={busy} type="submit">
            保存 Brief
          </button>
          <button className={secondaryButton} onClick={estimateCost} type="button">
            预估成本
          </button>
          <button
            className={secondaryButton}
            disabled={busy || !brief || copying || !canCreatePackage}
            onClick={() => void createPackage()}
            type="button"
          >
            创建内容包
          </button>
        </div>
      </form>
      {estimate ? (
        <aside
          className="mt-5 rounded-2xl border border-line bg-white p-5 shadow-panel"
          aria-label="成本预估"
        >
          <h2 className="font-semibold">成本工作量预估</h2>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
            <Metric label="输入 token" value={estimate.inputTokens} />
            <Metric label="输出 token" value={estimate.outputTokens} />
            <Metric label="生成请求" value={estimate.requests} />
          </dl>
          <p className="mt-3 text-xs text-ink-500">
            实际金额由保存时生效的模型路由和版本化费率卡计算，本页不伪造货币金额。
          </p>
        </aside>
      ) : null}
      <div aria-live="polite" className="mt-4 min-h-6">
        {message ? <p role="status">{message}</p> : null}
        {packageId ? (
          <Link className="ml-3 text-brand-700" href={`/cont-04?id=${packageId}`}>
            查看内容包
          </Link>
        ) : null}
      </div>
    </section>
  );
}

function parseForm(
  form: HTMLFormElement,
): { success: true; data: BriefSaveInput } | { success: false; message: string } {
  const data = new FormData(form);
  const dueAt = String(data.get('due_at') ?? '');
  const parsed = BriefSaveInputSchema.safeParse({
    audience: data.get('audience'),
    constraints: {
      additional_instructions: nullableText(data.get('additional_instructions')),
      cta: nullableText(data.get('cta')),
      schema_version: 'brief-constraints@1',
    },
    due_at: dueAt ? new Date(dueAt).toISOString() : null,
    keyword_ids: splitIds(data.get('keyword_ids')),
    objective: data.get('objective'),
    platform_codes: data.getAll('platform_codes'),
    primary_keyword_id: data.get('primary_keyword_id'),
    project_id: data.get('project_id'),
    source_ids: splitIds(data.get('source_ids')),
    title: data.get('title'),
    workspace_id: data.get('workspace_id'),
  });
  if (parsed.success) return { success: true, data: parsed.data };
  if (
    parsed.error.issues.some((issue) =>
      ['keyword_ids', 'platform_codes'].includes(String(issue.path[0])),
    )
  ) {
    return { success: false, message: '请填写有效字段，并至少选择一个平台和一个关键词。' };
  }
  const messages = parsed.error.issues.map((issue) => issue.message);
  if (messages.some((message) => message.includes('事实型')))
    return { success: false, message: '事实型 Brief 至少需要一个证据来源。' };
  if (messages.some((message) => message.includes('主关键词')))
    return { success: false, message: '主关键词必须包含在关键词列表中。' };
  return { success: false, message: '请填写有效字段，并至少选择一个平台和一个关键词。' };
}
function buildEstimate(input: BriefSaveInput): CostEstimate {
  const constraintCharacters = JSON.stringify(input.constraints).length;
  return {
    inputTokens: Math.ceil(
      800 +
        input.audience.length / 2 +
        constraintCharacters / 2 +
        input.keyword_ids.length * 80 +
        input.source_ids.length * 500,
    ),
    outputTokens:
      1800 + input.platform_codes.reduce((total, code) => total + OUTPUT_BUDGET[code], 0),
    requests: 1 + input.platform_codes.length,
  };
}
const OUTPUT_BUDGET: Readonly<Record<PlatformCode, number>> = {
  official_site: 2400,
  baijiahao: 1600,
  toutiao: 1800,
  zhihu: 2200,
  xiaohongshu: 1000,
  wechat_mp: 2000,
  douyin: 900,
};
interface CostEstimate {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly requests: number;
}
function splitIds(value: FormDataEntryValue | null) {
  return String(value ?? '')
    .split(/[\s,]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}
function nullableText(value: FormDataEntryValue | null) {
  const text = String(value ?? '').trim();
  return text || null;
}
function toLocalDateTime(value?: string | null) {
  return value ? new Date(value).toISOString().slice(0, 16) : '';
}
function isAccessError(error: unknown) {
  return (
    (error instanceof BriefEditorRequestError && [401, 403, 404].includes(error.status)) ||
    Boolean(
      error &&
      typeof error === 'object' &&
      [401, 403, 404].includes(Number((error as { status?: unknown }).status)),
    )
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
function TextField({
  defaultValue,
  label,
  name,
  readOnly,
  required,
  type = 'text',
}: {
  readonly defaultValue?: string | undefined;
  readonly label: string;
  readonly name: string;
  readonly readOnly?: boolean;
  readonly required?: boolean;
  readonly type?: string;
}) {
  return (
    <label className="text-sm text-ink-700">
      {label}
      <input
        className={controlClass}
        defaultValue={defaultValue ?? ''}
        name={name}
        readOnly={readOnly}
        required={required}
        type={type}
      />
    </label>
  );
}
function TextArea({
  defaultValue,
  label,
  name,
  required,
}: {
  readonly defaultValue?: string | undefined;
  readonly label: string;
  readonly name: string;
  readonly required?: boolean;
}) {
  return (
    <label className="mt-5 block text-sm text-ink-700">
      {label}
      <textarea
        className={`${controlClass} min-h-24 py-3`}
        defaultValue={defaultValue ?? ''}
        name={name}
        required={required}
      />
    </label>
  );
}
function SelectField({
  defaultValue,
  label,
  name,
}: {
  readonly defaultValue?: BriefObjective | undefined;
  readonly label: string;
  readonly name: string;
}) {
  return (
    <label className="text-sm text-ink-700">
      {label}
      <select className={controlClass} defaultValue={defaultValue ?? 'awareness'} name={name}>
        <option value="awareness">品牌认知</option>
        <option value="conversion">转化</option>
        <option value="trust">信任</option>
        <option value="education">教育</option>
      </select>
    </label>
  );
}
function Metric({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div>
      <dt className="text-ink-500">{label}</dt>
      <dd className="mt-1 text-xl font-semibold">{value.toLocaleString('zh-CN')}</dd>
    </div>
  );
}
function StatePanel({ title, text }: { readonly title: string; readonly text: string }) {
  return (
    <div className="mt-5 rounded-2xl border border-line bg-white p-8 text-center shadow-panel">
      <h2 className="font-semibold">{title}</h2>
      <p className="mt-2 text-sm text-ink-500">{text}</p>
    </div>
  );
}
const controlClass =
  'mt-2 w-full rounded-control border border-line bg-white px-3 text-sm text-ink-950 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-100 h-11';
const primaryButton =
  'h-11 rounded-control bg-brand-600 px-4 text-sm font-semibold text-white disabled:opacity-50';
const secondaryButton =
  'h-11 rounded-control border border-line px-4 text-sm font-semibold text-ink-700 disabled:opacity-50';
