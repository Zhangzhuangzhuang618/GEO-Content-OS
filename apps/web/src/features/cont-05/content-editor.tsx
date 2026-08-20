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
  requestManualEditQuality,
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
  'generation_failed',
  'quality_failed',
  'quality_passed',
  'review_rejected',
]);
const BLOCK_TYPES: readonly EditableBlock['block_type'][] = [
  'heading',
  'paragraph',
  'list',
  'quote',
  'media',
  'cta',
];

export function ContentEditor() {
  const [publishEdit] = useState(readPublishEdit);
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
    setPlatformMetaText(
      JSON.stringify(loaded.current_content?.content_json.platform_meta ?? {}, null, 2),
    );
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

  function validatedDraft(): ContentDocument | null {
    if (!detail || !draft) return null;
    let platformMeta: unknown;
    try {
      platformMeta = JSON.parse(platformMetaText);
    } catch {
      setMessage('平台字段必须是有效的 JSON 对象。');
      return null;
    }
    if (!platformMeta || typeof platformMeta !== 'object' || Array.isArray(platformMeta)) {
      setMessage('平台字段必须是有效的 JSON 对象。');
      return null;
    }
    const parsed = ContentDocumentSchema.safeParse({ ...draft, platform_meta: platformMeta });
    if (!parsed.success) {
      setMessage(parsed.error.issues[0]?.message ?? '内容格式无效。');
      return null;
    }
    return parsed.data;
  }

  async function save() {
    if (!detail) return;
    const parsed = validatedDraft();
    if (!parsed) return;
    await mutate(
      async (csrf) => applyLoaded(await saveVariant(detail, parsed, csrf)),
      '内容已保存。',
    );
  }

  async function saveAndRevalidatePublishEdit() {
    if (!detail || !publishEdit) return;
    const parsed = validatedDraft();
    if (!parsed) return;
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    setBusy(true);
    setConflict(false);
    setMessage(null);
    let saved = false;
    try {
      const target = dirty ? await saveVariant(detail, parsed, csrf) : detail;
      if (dirty) {
        saved = true;
        applyLoaded(target);
      }
      await requestManualEditQuality(target.variant.id, publishEdit.sourceJobId, csrf);
      setMessage(
        '修改已提交重新质检。自动化来源通过后会创建新任务，人工来源通过后按现有审核流程重新排期；不通过时保留为人工处理，不会自动改写。',
      );
    } catch (error) {
      if (error instanceof ContentEditorRequestError && error.status === 409) {
        setConflict(true);
        setMessage('版本或任务状态已变化，请重新加载后再提交。');
      } else {
        setMessage(
          saved
            ? '内容已保存，但重新质检未能启动；请保留当前页面并重试。'
            : '修改未能提交，请检查内容或任务状态后重试。',
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function toggleLock(blockId: string, locked: boolean) {
    if (!detail) return;
    await mutate(
      async (csrf) => {
        await setBlockLock(detail, blockId, !locked, lockReason, csrf);
        applyLoaded(await getVariantDetail(detail.variant.id));
      },
      locked ? '段落锁已解除。' : '段落已锁定。',
    );
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
    return <StatePanel title="无权编辑内容" text="需要内容编辑或企业管理员权限。" />;
  if (state === 'error' || !detail)
    return (
      <StatePanel title="无法加载内容" text="这份内容可能已失效、被删除或不在你的权限范围内。" />
    );

  const editable = MANUAL_EDIT_STATUSES.has(detail.variant.status);
  const regeneratable =
    REGENERATE_STATUSES.has(detail.variant.status) &&
    (detail.variant.is_required ||
      (detail.variant.platform_code === 'baijiahao' && Boolean(detail.automation_run)));
  const dirty = Boolean(
    draft &&
    (JSON.stringify(draft) !== JSON.stringify(detail.current_content?.content_json ?? null) ||
      platformMetaText !==
        JSON.stringify(detail.current_content?.content_json.platform_meta ?? {}, null, 2)),
  );

  return (
    <section className="mt-8 space-y-6">
      <section className="rounded-2xl border border-line bg-white p-5 shadow-panel sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-brand-50 px-3 py-1 text-sm font-semibold text-brand-700">
                {platformLabel(detail.variant.platform_code)}
              </span>
              <span className={statusBadgeClass(detail.variant.status)}>
                {statusLabel(detail.variant.status)}
              </span>
              <span className="text-sm text-ink-500">
                {dirty ? '有未保存的修改' : '当前内容已保存'}
              </span>
            </div>
            <h2 className="mt-3 text-xl font-semibold text-ink-950">
              {draft?.title || `${platformLabel(detail.variant.platform_code)}内容`}
            </h2>
          </div>
          <Link className={secondaryButton} href={`/cont-04?id=${detail.variant.package_id}`}>
            ← 返回内容详情
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

      {publishEdit ? (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-950 shadow-panel">
          <h2 className="font-semibold">正在修改已取消排期的文章</h2>
          <p className="mt-2 leading-6">
            原发布任务和历史尝试不会被覆盖。提交后会对这个新内容版本重新质检；未通过时保留给人工继续修改，不触发自动重写。
          </p>
          <Link
            className="mt-3 inline-block font-semibold underline"
            href={`/pub-03?id=${publishEdit.sourceJobId}`}
          >
            查看原发布任务
          </Link>
        </section>
      ) : null}

      {message ? (
        <p
          aria-live="polite"
          className="rounded-control border border-brand-100 bg-brand-50 p-4 text-sm text-brand-800"
        >
          {message}
        </p>
      ) : null}

      {draft ? (
        <EditorForm
          busy={busy}
          detail={detail}
          dirty={dirty}
          draft={draft}
          editable={editable}
          lockReason={lockReason}
          onChange={setDraft}
          onLockReason={setLockReason}
          onPlatformMeta={setPlatformMetaText}
          onPublishEdit={saveAndRevalidatePublishEdit}
          onSave={save}
          onToggleLock={toggleLock}
          platformMetaText={platformMetaText}
          publishEdit={publishEdit !== null}
        />
      ) : (
        <StatePanel title="暂无可编辑内容" text="该平台内容尚未生成，可返回内容详情重新生成。" />
      )}

      <section className="grid gap-6 lg:grid-cols-2">
        <InfoPanel title="事实依据">
          {detail.citations.length ? (
            <ul className="space-y-3 text-sm">
              {detail.citations.map((citation) => (
                <li key={citation.id}>
                  <p className="font-medium text-ink-900">{citation.claim_text}</p>
                  <p className="mt-1 text-ink-500">{citation.quote_text}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-500">当前版本没有引用。</p>
          )}
        </InfoPanel>
        <InfoPanel title="内容质量">
          {detail.quality_report ? (
            <div className="text-sm text-ink-700">
              <p className="text-2xl font-semibold text-ink-950">
                {Math.round(detail.quality_report.score)} 分
              </p>
              <p className="mt-2">
                检查结果：{qualityDecisionLabel(detail.quality_report.decision)}
              </p>
              <Link
                className="mt-3 inline-block text-brand-700"
                href={`/qual-01?id=${detail.variant.id}`}
              >
                查看完整质量报告
              </Link>
            </div>
          ) : (
            <p className="text-sm text-ink-500">当前版本尚无质量报告。</p>
          )}
        </InfoPanel>
      </section>

      <section className="rounded-2xl border border-line bg-white p-5 shadow-panel">
        <h2 className="text-lg font-semibold text-ink-950">让 AI 重新生成</h2>
        <p className="mt-1 text-sm text-ink-500">
          对当前平台重新生成内容，已标记“AI 不会改写”的段落将保持不变。
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="min-w-48 text-sm text-ink-700">
            生成偏好
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
            重新生成此平台内容
          </button>
          <span className="text-xs text-ink-500">
            将保留 {detail.locks.length} 个不允许 AI 改写的段落
          </span>
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
    </section>
  );
}

function EditorForm({
  busy,
  detail,
  dirty,
  draft,
  editable,
  lockReason,
  onChange,
  onLockReason,
  onPlatformMeta,
  onPublishEdit,
  onSave,
  onToggleLock,
  platformMetaText,
  publishEdit,
}: {
  readonly busy: boolean;
  readonly detail: VariantDetail;
  readonly dirty: boolean;
  readonly draft: ContentDocument;
  readonly editable: boolean;
  readonly lockReason: string;
  readonly onChange: (value: ContentDocument) => void;
  readonly onLockReason: (value: string) => void;
  readonly onPlatformMeta: (value: string) => void;
  readonly onPublishEdit: () => Promise<void>;
  readonly onSave: () => Promise<void>;
  readonly onToggleLock: (blockId: string, locked: boolean) => Promise<void>;
  readonly platformMetaText: string;
  readonly publishEdit: boolean;
}) {
  const [pendingLockKey, setPendingLockKey] = useState<string | null>(null);

  function patch(value: Partial<ContentDocument>) {
    onChange({ ...draft, ...value });
  }
  function patchBlock(index: number, value: Partial<EditableBlock>) {
    patch({
      blocks: draft.blocks.map((block, position) =>
        position === index ? { ...block, ...value } : block,
      ),
    });
  }
  function addBlock(blockType: EditableBlock['block_type']) {
    const sequence = draft.blocks.length + 1;
    patch({
      blocks: [
        ...draft.blocks,
        {
          block_key: `${blockType}_${sequence}`,
          block_type: blockType,
          text: '',
        },
      ],
    });
  }
  function moveBlock(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= draft.blocks.length) return;
    const blocks = [...draft.blocks];
    [blocks[index], blocks[target]] = [blocks[target]!, blocks[index]!];
    patch({ blocks });
  }
  const platformMeta = parseJsonObject(platformMetaText);

  return (
    <section className="overflow-visible rounded-2xl border border-line bg-white shadow-panel">
      <div className="sticky top-20 z-10 flex flex-wrap items-center justify-between gap-3 rounded-t-2xl border-b border-line bg-white/95 px-5 py-4 backdrop-blur sm:px-6">
        <div>
          <h2 className="font-semibold text-ink-950">编辑内容</h2>
          <p className="mt-1 text-xs text-ink-500">
            {dirty ? '修改尚未保存' : '没有未保存的修改'} · 保存后会自动保留历史版本
          </p>
        </div>
        <button
          className={primaryButton}
          disabled={busy || !editable || (!publishEdit && !dirty)}
          onClick={() => void (publishEdit ? onPublishEdit() : onSave())}
          type="button"
        >
          {busy
            ? '处理中…'
            : publishEdit
              ? dirty
                ? '保存并重新质检'
                : '重新质检当前内容'
              : '保存修改'}
        </button>
      </div>

      {!editable ? (
        <div className="border-b border-amber-200 bg-amber-50 px-5 py-3 text-sm text-amber-900 sm:px-6">
          当前状态为“{statusLabel(detail.variant.status)}”，暂时不能手动保存内容。
        </div>
      ) : null}

      <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_340px]">
        <article className="p-5 sm:p-8 lg:border-r lg:border-line">
          <TextField
            disabled={!editable}
            inputClassName="mt-2 min-h-14 w-full border-0 border-b border-line bg-transparent px-0 text-2xl font-semibold text-ink-950 outline-none focus:border-brand-600"
            label="文章标题"
            maxLength={80}
            value={draft.title}
            onChange={(value) => patch({ title: value })}
          />
          <p className="mt-2 text-right text-xs text-ink-400">{draft.title.length}/80</p>

          <TextArea
            disabled={!editable}
            label="内容摘要（可选）"
            maxLength={1000}
            placeholder="用一两句话告诉读者，这篇内容能解决什么问题。"
            value={draft.summary}
            onChange={(value) => patch({ summary: value })}
          />

          <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-ink-950">正文内容</h3>
              <p className="mt-1 text-sm text-ink-500">按阅读顺序编辑各段，可调整类型和顺序。</p>
            </div>
            <span className="text-sm text-ink-500">共 {draft.blocks.length} 段</span>
          </div>

          <div className="mt-4 space-y-4">
            {draft.blocks.map((block, index) => {
              const stored = detail.current_content?.blocks.find(
                (item) => item.block_key === block.block_key,
              );
              const locked = detail.locks.some((item) => item.block_key === block.block_key);
              const pendingLock = pendingLockKey === block.block_key;
              return (
                <section
                  className={`scroll-mt-36 rounded-xl border p-4 transition ${
                    locked ? 'border-brand-200 bg-brand-50/40' : 'border-line bg-white'
                  }`}
                  id={`block-${block.block_key}`}
                  key={`${block.block_key}-${index}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-ink-400">第 {index + 1} 段</span>
                      {locked ? (
                        <span className="rounded-full bg-brand-100 px-2 py-1 text-xs font-medium text-brand-800">
                          AI 不会改写
                        </span>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        aria-label={`上移第 ${index + 1} 段`}
                        className={iconButton}
                        disabled={busy || !editable || locked || index === 0}
                        onClick={() => moveBlock(index, -1)}
                        type="button"
                      >
                        ↑
                      </button>
                      <button
                        aria-label={`下移第 ${index + 1} 段`}
                        className={iconButton}
                        disabled={busy || !editable || locked || index === draft.blocks.length - 1}
                        onClick={() => moveBlock(index, 1)}
                        type="button"
                      >
                        ↓
                      </button>
                      <select
                        aria-label={`第 ${index + 1} 段类型`}
                        className="h-9 rounded-control border border-line bg-white px-2 text-sm text-ink-700"
                        disabled={!editable || locked}
                        onChange={(event) =>
                          patchBlock(index, {
                            block_type: event.target.value as EditableBlock['block_type'],
                          })
                        }
                        value={block.block_type}
                      >
                        {BLOCK_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {blockTypeLabel(type)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <TextArea
                    ariaLabel={`第 ${index + 1} 段内容`}
                    disabled={!editable || locked}
                    label="内容"
                    labelClassName="sr-only"
                    minHeight={block.block_type === 'heading' ? 'min-h-16' : 'min-h-32'}
                    placeholder={blockPlaceholder(block.block_type)}
                    value={block.text}
                    onChange={(value) => patchBlock(index, { text: value })}
                  />

                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    {stored ? (
                      locked ? (
                        <button
                          aria-label="解除段落锁"
                          className={textButton}
                          disabled={busy || !editable}
                          onClick={() => void onToggleLock(stored.id, true)}
                          type="button"
                        >
                          允许 AI 改写
                        </button>
                      ) : (
                        <button
                          aria-label="锁定段落"
                          className={textButton}
                          disabled={busy || !editable}
                          onClick={() => {
                            setPendingLockKey(pendingLock ? null : block.block_key);
                            onLockReason('');
                          }}
                          type="button"
                        >
                          保留这段，不让 AI 改写
                        </button>
                      )
                    ) : null}
                    {draft.blocks.length > 1 ? (
                      <button
                        className="text-sm font-medium text-red-600 disabled:text-ink-300"
                        disabled={busy || !editable || locked}
                        onClick={() =>
                          patch({
                            blocks: draft.blocks.filter((_, position) => position !== index),
                          })
                        }
                        type="button"
                      >
                        删除本段
                      </button>
                    ) : null}
                  </div>

                  {pendingLock && stored && !locked ? (
                    <div className="mt-4 rounded-control bg-surface-subtle p-4">
                      <TextField
                        label="保留原因（可选）"
                        placeholder="例如：这段是已确认的品牌表述"
                        value={lockReason}
                        onChange={onLockReason}
                      />
                      <div className="mt-3 flex gap-2">
                        <button
                          className={primaryButton}
                          disabled={busy}
                          onClick={() => {
                            setPendingLockKey(null);
                            void onToggleLock(stored.id, false);
                          }}
                          type="button"
                        >
                          确认保留
                        </button>
                        <button
                          className={secondaryButton}
                          onClick={() => setPendingLockKey(null)}
                          type="button"
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              className={secondaryButton}
              disabled={busy || !editable}
              onClick={() => addBlock('paragraph')}
              type="button"
            >
              ＋ 添加段落
            </button>
            <button
              className={secondaryButton}
              disabled={busy || !editable}
              onClick={() => addBlock('heading')}
              type="button"
            >
              ＋ 添加小标题
            </button>
            <button
              className={secondaryButton}
              disabled={busy || !editable}
              onClick={() => addBlock('list')}
              type="button"
            >
              ＋ 添加列表
            </button>
          </div>
        </article>

        <aside className="space-y-6 bg-surface-subtle/60 p-5 sm:p-6">
          <section>
            <h3 className="font-semibold text-ink-950">发布设置</h3>
            <TextField
              disabled={!editable}
              label="内容标签"
              placeholder="例如：搬家攻略，广州生活"
              value={draft.hashtags.join('，')}
              onChange={(value) => patch({ hashtags: splitList(value) })}
            />
            <p className="mt-2 text-xs leading-5 text-ink-500">可用逗号或换行分隔多个标签。</p>
            <TextArea
              disabled={!editable}
              label="行动引导（可选）"
              minHeight="min-h-24"
              placeholder="例如：联系我们获取专属方案"
              value={draft.cta ?? ''}
              onChange={(value) => patch({ cta: value || null })}
            />
          </section>

          <section className="border-t border-line pt-5">
            <h3 className="font-semibold text-ink-950">
              {platformLabel(detail.variant.platform_code)}专属设置
            </h3>
            <p className="mt-1 text-xs leading-5 text-ink-500">
              这些信息只影响当前平台的展示方式。
            </p>
            <PlatformSettings
              disabled={!editable}
              metadata={platformMeta}
              onChange={onPlatformMeta}
            />
          </section>
        </aside>
      </div>
    </section>
  );
}

function PlatformSettings({
  disabled,
  metadata,
  onChange,
}: {
  readonly disabled: boolean;
  readonly metadata: Record<string, unknown> | null;
  readonly onChange: (value: string) => void;
}) {
  if (!metadata) {
    return <p className="mt-4 text-sm text-red-600">高级平台数据格式有误，请展开后修正。</p>;
  }
  const entries = Object.entries(metadata).filter(([, value]) => isPrimitive(value));
  if (entries.length === 0) {
    return <p className="mt-4 text-sm text-ink-500">当前平台没有需要额外填写的设置。</p>;
  }
  function update(key: string, rawValue: string, currentValue: unknown) {
    const nextValue =
      typeof currentValue === 'number'
        ? Number(rawValue)
        : typeof currentValue === 'boolean'
          ? rawValue === 'true'
          : rawValue;
    onChange(JSON.stringify({ ...metadata, [key]: nextValue }, null, 2));
  }
  return (
    <div className="mt-4 space-y-4">
      {entries.map(([key, value]) =>
        typeof value === 'boolean' ? (
          <label className="block text-sm text-ink-700" key={key}>
            {platformFieldLabel(key)}
            <select
              className={controlClass}
              disabled={disabled}
              onChange={(event) => update(key, event.target.value, value)}
              value={String(value)}
            >
              <option value="true">是</option>
              <option value="false">否</option>
            </select>
          </label>
        ) : (
          <TextArea
            disabled={disabled}
            key={key}
            label={platformFieldLabel(key)}
            minHeight="min-h-24"
            value={String(value ?? '')}
            onChange={(next) => update(key, next, value)}
          />
        ),
      )}
      {Object.keys(metadata).length > entries.length ? (
        <p className="text-xs leading-5 text-ink-500">其他平台设置由系统自动维护，无需手动填写。</p>
      ) : null}
    </div>
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
      <h2 className="text-lg font-semibold text-ink-950">历史版本</h2>
      <p className="mt-1 text-sm text-ink-500">每次保存都会生成一个可恢复的历史版本。</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <VersionSelect
          label="基准版本"
          onChange={onBase}
          value={baseVersionId}
          versions={detail.versions}
        />
        <VersionSelect
          label="对比版本"
          onChange={onTarget}
          value={targetVersionId}
          versions={detail.versions}
        />
      </div>
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          className={secondaryButton}
          disabled={busy || !baseVersionId || !targetVersionId || baseVersionId === targetVersionId}
          onClick={() => void onCompare()}
          type="button"
        >
          比较版本
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
              版本 {version.version_no} · {new Date(version.created_at).toLocaleString('zh-CN')}
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

function VersionSelect({
  label,
  onChange,
  value,
  versions,
}: {
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly value: string;
  readonly versions: VariantDetail['versions'];
}) {
  return (
    <label className="text-sm text-ink-700">
      {label}
      <select
        className={controlClass}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="">请选择</option>
        {versions.map((version) => (
          <option key={version.id} value={version.id}>
            v{version.version_no}
          </option>
        ))}
      </select>
    </label>
  );
}
function TextField({
  disabled,
  inputClassName,
  label,
  maxLength,
  onChange,
  placeholder,
  value,
}: {
  readonly disabled?: boolean;
  readonly inputClassName?: string;
  readonly label: string;
  readonly maxLength?: number;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly value: string;
}) {
  return (
    <label className="block text-sm text-ink-700">
      {label}
      <input
        className={inputClassName ?? controlClass}
        disabled={disabled}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
    </label>
  );
}
function TextArea({
  ariaLabel,
  disabled,
  label,
  labelClassName,
  maxLength,
  minHeight = 'min-h-24',
  onChange,
  placeholder,
  value,
}: {
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
  readonly label: string;
  readonly labelClassName?: string;
  readonly maxLength?: number;
  readonly minHeight?: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly value: string;
}) {
  return (
    <label className="mt-3 block text-sm text-ink-700">
      <span className={labelClassName}>{label}</span>
      <textarea
        aria-label={ariaLabel}
        className={`${controlClass} ${minHeight} py-3 leading-7 disabled:bg-surface-subtle disabled:text-ink-500`}
        disabled={disabled}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
    </label>
  );
}
function InfoPanel({
  children,
  title,
}: {
  readonly children: React.ReactNode;
  readonly title: string;
}) {
  return (
    <section className="rounded-2xl border border-line bg-white p-5 shadow-panel">
      <h2 className="text-lg font-semibold text-ink-950">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}
function StatePanel({ title, text }: { readonly title: string; readonly text: string }) {
  return (
    <div className="mt-5 rounded-2xl border border-line bg-white p-8 text-center shadow-panel">
      <h2 className="font-semibold text-ink-950">{title}</h2>
      <p className="mt-2 text-sm text-ink-500">{text}</p>
    </div>
  );
}
function splitList(value: string) {
  return value
    .split(/[,，\n]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}
function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
function isPrimitive(value: unknown): value is boolean | null | number | string {
  return value === null || ['boolean', 'number', 'string'].includes(typeof value);
}
function blockTypeLabel(type: EditableBlock['block_type']) {
  return {
    cta: '行动引导',
    heading: '小标题',
    list: '列表',
    media: '媒体说明',
    paragraph: '正文段落',
    quote: '引用',
  }[type];
}
function blockPlaceholder(type: EditableBlock['block_type']) {
  return {
    cta: '写下希望读者采取的下一步行动…',
    heading: '输入这一部分的小标题…',
    list: '每行填写一项…',
    media: '填写图片或视频说明…',
    paragraph: '输入正文内容…',
    quote: '输入引用内容…',
  }[type];
}
function platformFieldLabel(key: string) {
  return (
    {
      category: '内容分类',
      content_type: '内容类型',
      cover_image_url: '封面图片地址',
      meta_description: '搜索结果描述',
      source_url: '原文链接',
    }[key] ?? key.replaceAll('_', ' ')
  );
}
function platformLabel(code: string) {
  return (
    {
      official_site: '官网',
      baijiahao: '百家号',
      lieju: '列举网',
      sohu: '搜狐号',
      toutiao: '头条号',
      zhihu: '知乎',
      xiaohongshu: '小红书',
      wechat_mp: '微信公众号',
      douyin: '抖音',
    }[code] ?? code
  );
}
function statusLabel(status: string) {
  return (
    {
      approved: '已通过审核',
      generated: '已生成',
      generating: '正在生成',
      generation_failed: '生成失败',
      published: '已发布',
      quality_failed: '需要修改',
      quality_passed: '质量检查通过',
      review_rejected: '审核退回',
      review_submitted: '审核中',
    }[status] ?? status
  );
}
function qualityDecisionLabel(decision: string) {
  return (
    {
      block: '不可进入审核',
      pass: '通过',
      revise: '需要修改',
    }[decision] ?? decision
  );
}
function statusBadgeClass(status: string) {
  const tone =
    status === 'generation_failed' || status === 'quality_failed' || status === 'review_rejected'
      ? 'bg-red-50 text-red-700'
      : status === 'generating' || status === 'review_submitted'
        ? 'bg-amber-50 text-amber-800'
        : 'bg-emerald-50 text-emerald-700';
  return `rounded-full px-3 py-1 text-sm font-medium ${tone}`;
}
function isAccessError(error: unknown) {
  if (error instanceof ContentEditorRequestError) return [401, 403, 404].includes(error.status);
  if (!error || typeof error !== 'object') return false;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === 'number' && [401, 403, 404].includes(status);
}
function readPublishEdit(): { readonly sourceJobId: string } | null {
  if (typeof window === 'undefined') return null;
  const query = new URLSearchParams(window.location.search);
  const sourceJobId = query.get('publish_job_id');
  return query.get('publish_edit') === '1' &&
    sourceJobId &&
    z.string().uuid().safeParse(sourceJobId).success
    ? Object.freeze({ sourceJobId })
    : null;
}
function readCookie(name: string) {
  const entry = document.cookie.split('; ').find((value) => value.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
}
const controlClass =
  'mt-2 min-h-11 w-full rounded-control border border-line bg-white px-3 text-sm text-ink-950 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-100';
const primaryButton =
  'inline-flex h-11 items-center justify-center rounded-control bg-brand-600 px-4 text-sm font-semibold text-white disabled:opacity-50';
const secondaryButton =
  'inline-flex h-11 items-center justify-center rounded-control border border-line px-4 text-sm font-semibold text-ink-700 disabled:opacity-50';
const iconButton =
  'inline-flex h-9 w-9 items-center justify-center rounded-control border border-line bg-white text-sm font-semibold text-ink-600 disabled:opacity-30';
const textButton = 'text-sm font-medium text-brand-700 disabled:text-ink-300';
