'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import {
  ContentEditorRequestError,
  getVariantDetail,
  loadVersionDiff,
  regenerateVariant,
  rollbackVersion,
  saveVariant,
  setBlockLock,
} from './content-editor-api';
import {
  ContentDocumentSchema,
  type ContentDiff,
  type ContentDocument,
  type EditableBlock,
  type ModelPolicy,
  type VariantDetail,
} from './content-editor.schema';

const EDITOR_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'content_editor']);
const MANUAL_EDIT_STATUSES = new Set([
  'approved',
  'generated',
  'published',
  'quality_failed',
  'quality_passed',
  'review_rejected',
]);
const REGENERATE_STATUSES = new Set([
  'generated',
  'quality_failed',
  'quality_passed',
  'review_rejected',
]);

export function ContentEditor() {
  const [detail, setDetail] = useState<VariantDetail | null>(null);
  const [draft, setDraft] = useState<ContentDocument | null>(null);
  const [platformMetaText, setPlatformMetaText] = useState('{}');
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'permission'>('loading');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [lockReason, setLockReason] = useState('');
  const [rollbackReason, setRollbackReason] = useState('');
  const [modelPolicy, setModelPolicy] = useState<ModelPolicy>('balanced');
  const [baseVersionId, setBaseVersionId] = useState('');
  const [targetVersionId, setTargetVersionId] = useState('');
  const [diff, setDiff] = useState<ContentDiff | null>(null);

  async function load(id: string, signal?: AbortSignal) {
    const loaded = await getVariantDetail(id, signal);
    applyLoaded(loaded);
  }

  function applyLoaded(loaded: VariantDetail) {
    setDetail(loaded);
    setDraft(loaded.current_content?.content_json ?? null);
    setPlatformMetaText(JSON.stringify(loaded.current_content?.content_json.platform_meta ?? {}, null, 2));
    setBaseVersionId(loaded.current_content?.id ?? loaded.versions[0]?.id ?? '');
    setTargetVersionId(
      loaded.versions.find((version) => version.id !== loaded.current_content?.id)?.id ?? '',
    );
    setConflict(false);
  }

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('id');
    if (!id || !z.string().uuid().safeParse(id).success) {
      setState('error');
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const [tenants, loaded] = await Promise.all([
          listAvailableTenants(controller.signal),
          getVariantDetail(id, controller.signal),
        ]);
        const role = tenants.find((tenant) => tenant.is_active)?.role_code;
        if (!role || !EDITOR_ROLES.has(role)) {
          setState('permission');
          return;
        }
        applyLoaded(loaded);
        setState('ready');
      } catch (error) {
        if (controller.signal.aborted) return;
        setState(isAccessError(error) ? 'permission' : 'error');
      }
    })();
    return () => controller.abort();
  }, []);

  async function save() {
    if (!detail || !draft) return;
    let platformMeta: unknown;
    try {
      platformMeta = JSON.parse(platformMetaText);
    } catch {
      setMessage('平台字段必须是有效的 JSON 对象。');
      return;
    }
    if (!platformMeta || typeof platformMeta !== 'object' || Array.isArray(platformMeta)) {
      setMessage('平台字段必须是有效的 JSON 对象。');
      return;
    }
    const parsed = ContentDocumentSchema.safeParse({ ...draft, platform_meta: platformMeta });
    if (!parsed.success) {
      setMessage(parsed.error.issues[0]?.message ?? '内容格式无效。');
      return;
    }
    await mutate(async (csrf) => applyLoaded(await saveVariant(detail, parsed.data, csrf)), '内容已保存。');
  }

  async function toggleLock(blockId: string, locked: boolean) {
    if (!detail) return;
    await mutate(async (csrf) => {
      await setBlockLock(detail, blockId, !locked, lockReason, csrf);
      applyLoaded(await getVariantDetail(detail.variant.id));
    }, locked ? '段落锁已解除。' : '段落已锁定。');
  }

  async function regenerate() {
    if (!detail) return;
    await mutate(async (csrf) => {
      await regenerateVariant(detail, modelPolicy, csrf);
      applyLoaded(await getVariantDetail(detail.variant.id));
    }, '再生成运行已创建。');
  }

  async function rollback(versionId: string) {
    if (!detail) return;
    await mutate(async (csrf) => {
      await rollbackVersion(detail, versionId, rollbackReason, csrf);
      applyLoaded(await getVariantDetail(detail.variant.id));
    }, '已回滚到所选版本。');
  }

  async function compare() {
    if (!baseVersionId || !targetVersionId || baseVersionId === targetVersionId) return;
    setBusy(true);
    setMessage(null);
    try {
      setDiff(await loadVersionDiff(baseVersionId, targetVersionId));
    } catch {
      setMessage('版本 diff 加载失败。');
    } finally {
      setBusy(false);
    }
  }

  async function mutate(work: (csrf: string) => Promise<void>, success: string) {
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    setBusy(true);
    setConflict(false);
    setMessage(null);
    try {
      await work(csrf);
      setMessage(success);
    } catch (error) {
      if (error instanceof ContentEditorRequestError && error.status === 409) {
        setConflict(true);
        setMessage('版本冲突：服务端内容已变化，本地内容未覆盖。请重新加载。');
      } else setMessage('操作失败，请检查内容状态或稍后重试。');
    } finally {
      setBusy(false);
    }
  }

  if (state === 'loading')
    return <StatePanel title="正在加载编辑器" text="正在读取当前版本、段落锁和历史。" />;
  if (state === 'permission')
    return <StatePanel title="无权编辑内容" text="需要内容编辑或租户管理员权限。" />;
  if (state === 'error' || !detail)
    return <StatePanel title="无法加载内容" text="请确认 URL 中包含有效且可访问的变体 ID。" />;

  const editable = MANUAL_EDIT_STATUSES.has(detail.variant.status);
  const regeneratable =
    detail.variant.is_required && REGENERATE_STATUSES.has(detail.variant.status);

  return (
    <section className="mt-8 space-y-6">
      <section className="rounded-2xl border border-line bg-white p-5 shadow-panel">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold text-ink-950">
              {platformLabel(detail.variant.platform_code)}变体
            </h2>
            <p className="mt-2 font-mono text-xs text-ink-500">{detail.variant.id}</p>
            <p className="mt-2 text-sm text-ink-600">
              状态 {detail.variant.status} · version {detail.variant.version}（所有写操作均携带）
            </p>
          </div>
          <Link className={secondaryButton} href={`/cont-04?id=${detail.variant.package_id}`}>
            返回内容包
          </Link>
        </div>
        {conflict ? (
          <button
            className={`${secondaryButton} mt-4`}
            disabled={busy}
            onClick={() => void load(detail.variant.id)}
            type="button"
          >
            重新加载服务端版本
          </button>
        ) : null}
      </section>

      {draft ? (
        <EditorForm
          busy={busy}
          detail={detail}
          draft={draft}
          editable={editable}
          lockReason={lockReason}
          onChange={setDraft}
          onLockReason={setLockReason}
          onPlatformMeta={setPlatformMetaText}
          onSave={save}
          onToggleLock={toggleLock}
          platformMetaText={platformMetaText}
        />
      ) : (
        <StatePanel title="暂无当前内容" text="该变体尚无可编辑版本，可在允许状态下发起再生成。" />
      )}

      <section className="grid gap-6 lg:grid-cols-2">
        <InfoPanel title="引用">
          {detail.citations.length ? (
            <ul className="space-y-3 text-sm">
              {detail.citations.map((citation) => (
                <li key={citation.id}>
                  <p className="font-medium text-ink-900">{citation.claim_text}</p>
                  <p className="mt-1 text-ink-500">{citation.quote_text}</p>
                  <p className="mt-1 font-mono text-xs text-ink-500">chunk {citation.chunk_id}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-500">当前版本没有引用。</p>
          )}
        </InfoPanel>
        <InfoPanel title="质量">
          {detail.quality_report ? (
            <div className="text-sm text-ink-700">
              <p className="text-2xl font-semibold text-ink-950">
                {Math.round(detail.quality_report.score)} 分
              </p>
              <p className="mt-2">decision: {detail.quality_report.decision}</p>
              <Link className="mt-3 inline-block text-brand-700" href={`/qual-01?id=${detail.variant.id}`}>
                查看完整质量报告
              </Link>
            </div>
          ) : (
            <p className="text-sm text-ink-500">当前版本尚无质量报告。</p>
          )}
        </InfoPanel>
      </section>

      <section className="rounded-2xl border border-line bg-white p-5 shadow-panel">
        <h2 className="text-lg font-semibold text-ink-950">再生成</h2>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="min-w-48 text-sm text-ink-700">
            模型策略
            <select
              className={controlClass}
              onChange={(event) => setModelPolicy(event.target.value as ModelPolicy)}
              value={modelPolicy}
            >
              <option value="fast">快速</option>
              <option value="balanced">平衡</option>
              <option value="quality">质量优先</option>
            </select>
          </label>
          <button
            className={primaryButton}
            disabled={busy || !regeneratable}
            onClick={() => void regenerate()}
            type="button"
          >
            再生成当前变体
          </button>
          <span className="text-xs text-ink-500">保留 {detail.locks.length} 个已锁段落</span>
        </div>
      </section>

      <VersionHistory
        baseVersionId={baseVersionId}
        busy={busy}
        detail={detail}
        diff={diff}
        editable={editable}
        onBase={setBaseVersionId}
        onCompare={compare}
        onReason={setRollbackReason}
        onRollback={rollback}
        onTarget={setTargetVersionId}
        reason={rollbackReason}
        targetVersionId={targetVersionId}
      />

      {message ? (
        <p aria-live="polite" className="rounded-control bg-white p-4 text-sm text-ink-700 shadow-panel">
          {message}
        </p>
      ) : null}
    </section>
  );
}

function EditorForm({
  busy,
  detail,
  draft,
  editable,
  lockReason,
  onChange,
  onLockReason,
  onPlatformMeta,
  onSave,
  onToggleLock,
  platformMetaText,
}: {
  readonly busy: boolean;
  readonly detail: VariantDetail;
  readonly draft: ContentDocument;
  readonly editable: boolean;
  readonly lockReason: string;
  readonly onChange: (value: ContentDocument) => void;
  readonly onLockReason: (value: string) => void;
  readonly onPlatformMeta: (value: string) => void;
  readonly onSave: () => Promise<void>;
  readonly onToggleLock: (blockId: string, locked: boolean) => Promise<void>;
  readonly platformMetaText: string;
}) {
  function patch(value: Partial<ContentDocument>) {
    onChange({ ...draft, ...value });
  }
  function patchBlock(index: number, value: Partial<EditableBlock>) {
    patch({ blocks: draft.blocks.map((block, position) => (position === index ? { ...block, ...value } : block)) });
  }
  return (
    <section className="rounded-2xl border border-line bg-white p-5 shadow-panel">
      <h2 className="text-lg font-semibold text-ink-950">结构化内容</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <TextField label="标题" value={draft.title} onChange={(value) => patch({ title: value })} />
        <TextField
          label="Hashtags（逗号分隔）"
          value={draft.hashtags.join(',')}
          onChange={(value) => patch({ hashtags: splitList(value) })}
        />
        <TextArea label="摘要" value={draft.summary} onChange={(value) => patch({ summary: value })} />
        <TextArea label="CTA" value={draft.cta ?? ''} onChange={(value) => patch({ cta: value || null })} />
        <TextArea
          label="平台字段 JSON"
          value={platformMetaText}
          onChange={onPlatformMeta}
        />
        <TextField label="锁定原因（可选）" value={lockReason} onChange={onLockReason} />
      </div>
      <div className="mt-6 space-y-4">
        {draft.blocks.map((block, index) => {
          const stored = detail.current_content?.blocks.find((item) => item.block_key === block.block_key);
          const locked = detail.locks.some((item) => item.block_key === block.block_key);
          return (
            <fieldset className="rounded-control border border-line p-4" key={`${block.block_key}-${index}`}>
              <legend className="px-2 text-sm font-medium text-ink-700">内容块 {index + 1}</legend>
              <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
                <TextField
                  label="block_key"
                  value={block.block_key}
                  onChange={(value) => patchBlock(index, { block_key: value })}
                />
                <label className="text-sm text-ink-700">
                  类型
                  <select
                    className={controlClass}
                    onChange={(event) =>
                      patchBlock(index, { block_type: event.target.value as EditableBlock['block_type'] })
                    }
                    value={block.block_type}
                  >
                    {['heading', 'paragraph', 'list', 'quote', 'media', 'cta'].map((type) => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                </label>
              </div>
              <TextArea label="正文" value={block.text} onChange={(value) => patchBlock(index, { text: value })} />
              <div className="mt-3 flex flex-wrap gap-3">
                {stored ? (
                  <button
                    className={secondaryButton}
                    disabled={busy}
                    onClick={() => void onToggleLock(stored.id, locked)}
                    type="button"
                  >
                    {locked ? '解除段落锁' : '锁定段落'}
                  </button>
                ) : null}
                {draft.blocks.length > 1 ? (
                  <button
                    className={secondaryButton}
                    disabled={busy || locked}
                    onClick={() => patch({ blocks: draft.blocks.filter((_, position) => position !== index) })}
                    type="button"
                  >
                    删除内容块
                  </button>
                ) : null}
              </div>
            </fieldset>
          );
        })}
      </div>
      <div className="mt-5 flex flex-wrap gap-3">
        <button
          className={secondaryButton}
          disabled={busy}
          onClick={() =>
            patch({
              blocks: [
                ...draft.blocks,
                { block_key: `block_${draft.blocks.length + 1}`, block_type: 'paragraph', text: '' },
              ],
            })
          }
          type="button"
        >
          添加内容块
        </button>
        <button
          className={primaryButton}
          disabled={busy || !editable}
          onClick={() => void onSave()}
          type="button"
        >
          保存新版本
        </button>
      </div>
    </section>
  );
}

function VersionHistory({
  baseVersionId,
  busy,
  detail,
  diff,
  editable,
  onBase,
  onCompare,
  onReason,
  onRollback,
  onTarget,
  reason,
  targetVersionId,
}: {
  readonly baseVersionId: string;
  readonly busy: boolean;
  readonly detail: VariantDetail;
  readonly diff: ContentDiff | null;
  readonly editable: boolean;
  readonly onBase: (value: string) => void;
  readonly onCompare: () => Promise<void>;
  readonly onReason: (value: string) => void;
  readonly onRollback: (id: string) => Promise<void>;
  readonly onTarget: (value: string) => void;
  readonly reason: string;
  readonly targetVersionId: string;
}) {
  return (
    <section className="rounded-2xl border border-line bg-white p-5 shadow-panel">
      <h2 className="text-lg font-semibold text-ink-950">版本历史</h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <VersionSelect label="基准版本" onChange={onBase} value={baseVersionId} versions={detail.versions} />
        <VersionSelect label="对比版本" onChange={onTarget} value={targetVersionId} versions={detail.versions} />
      </div>
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          className={secondaryButton}
          disabled={busy || !baseVersionId || !targetVersionId || baseVersionId === targetVersionId}
          onClick={() => void onCompare()}
          type="button"
        >
          查看 diff
        </button>
        <TextField label="回滚原因（可选）" value={reason} onChange={onReason} />
      </div>
      {diff ? (
        <div className="mt-4 rounded-control bg-surface-subtle p-4 text-sm text-ink-700">
          v{diff.base.version_no} → v{diff.target.version_no}：{diff.fields.length} 个字段、
          {diff.blocks.length} 个内容块变化
        </div>
      ) : null}
      <ul className="mt-5 divide-y divide-line text-sm">
        {detail.versions.map((version) => (
          <li className="flex flex-wrap items-center justify-between gap-3 py-3" key={version.id}>
            <span>
              v{version.version_no} · {version.content_hash.slice(0, 12)} ·{' '}
              {new Date(version.created_at).toLocaleString('zh-CN')}
            </span>
            {version.id === detail.current_content?.id ? (
              <span className="text-ink-500">当前版本</span>
            ) : (
              <button
                className="text-brand-700 disabled:text-ink-500"
                disabled={busy || !editable}
                onClick={() => void onRollback(version.id)}
                type="button"
              >
                回滚到此版本
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function VersionSelect({ label, onChange, value, versions }: { readonly label: string; readonly onChange: (value: string) => void; readonly value: string; readonly versions: VariantDetail['versions'] }) {
  return (
    <label className="text-sm text-ink-700">
      {label}
      <select className={controlClass} onChange={(event) => onChange(event.target.value)} value={value}>
        <option value="">请选择</option>
        {versions.map((version) => <option key={version.id} value={version.id}>v{version.version_no}</option>)}
      </select>
    </label>
  );
}
function TextField({ label, onChange, value }: { readonly label: string; readonly onChange: (value: string) => void; readonly value: string }) {
  return <label className="text-sm text-ink-700">{label}<input className={controlClass} onChange={(event) => onChange(event.target.value)} value={value} /></label>;
}
function TextArea({ label, onChange, value }: { readonly label: string; readonly onChange: (value: string) => void; readonly value: string }) {
  return <label className="mt-3 block text-sm text-ink-700">{label}<textarea className={`${controlClass} min-h-24 py-3`} onChange={(event) => onChange(event.target.value)} value={value} /></label>;
}
function InfoPanel({ children, title }: { readonly children: React.ReactNode; readonly title: string }) {
  return <section className="rounded-2xl border border-line bg-white p-5 shadow-panel"><h2 className="text-lg font-semibold text-ink-950">{title}</h2><div className="mt-4">{children}</div></section>;
}
function StatePanel({ title, text }: { readonly title: string; readonly text: string }) {
  return <div className="mt-5 rounded-2xl border border-line bg-white p-8 text-center shadow-panel"><h2 className="font-semibold text-ink-950">{title}</h2><p className="mt-2 text-sm text-ink-500">{text}</p></div>;
}
function splitList(value: string) { return value.split(/[,，\n]/u).map((item) => item.trim()).filter(Boolean); }
function platformLabel(code: string) { return { official_site: '官网', baijiahao: '百家号', toutiao: '头条号', zhihu: '知乎', xiaohongshu: '小红书', wechat_mp: '微信公众号', douyin: '抖音' }[code] ?? code; }
function isAccessError(error: unknown) { if (error instanceof ContentEditorRequestError) return [401, 403, 404].includes(error.status); if (!error || typeof error !== 'object') return false; const status = (error as { readonly status?: unknown }).status; return typeof status === 'number' && [401, 403, 404].includes(status); }
function readCookie(name: string) { const entry = document.cookie.split('; ').find((value) => value.startsWith(`${name}=`)); return entry ? decodeURIComponent(entry.slice(name.length + 1)) : ''; }
const controlClass = 'mt-2 min-h-11 w-full rounded-control border border-line bg-white px-3 text-sm text-ink-950 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-100';
const primaryButton = 'inline-flex h-11 items-center justify-center rounded-control bg-brand-600 px-4 text-sm font-semibold text-white disabled:opacity-50';
const secondaryButton = 'inline-flex h-11 items-center justify-center rounded-control border border-line px-4 text-sm font-semibold text-ink-700 disabled:opacity-50';
