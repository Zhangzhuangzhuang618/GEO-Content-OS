'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import {
  ContentPackageDetailRequestError,
  generatePackage,
  getContentPackageDetail,
  mutatePackage,
  submitPackageReview,
} from './content-package-detail-api';
import type {
  ModelPolicy,
  PackageAction,
  PackageDetail,
  VariantDetail,
} from './content-package-detail.schema';

const PRODUCER_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'content_editor']);
const ADMIN_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin']);
const GENERATABLE = new Set(['draft', 'generated', 'generation_failed', 'quality_failed']);
const ACTIVE_RUNS = new Set(['queued', 'running']);

export function ContentPackageDetail() {
  const [detail, setDetail] = useState<PackageDetail | null>(null);
  const [role, setRole] = useState<TenantRole | null>(null);
  const [selectedReviewIds, setSelectedReviewIds] = useState<string[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'permission'>('loading');
  const [busy, setBusy] = useState<PackageAction | null>(null);
  const [modelPolicy, setModelPolicy] = useState<ModelPolicy>('balanced');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);

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
          getContentPackageDetail(id, controller.signal),
        ]);
        const activeRole = tenants.find((tenant) => tenant.is_active)?.role_code;
        if (!activeRole) {
          setState('permission');
          return;
        }
        setRole(activeRole);
        applyDetail(loaded, setDetail, setSelectedReviewIds);
        setState('ready');
      } catch (error) {
        if (controller.signal.aborted) return;
        setState(isAccessError(error) ? 'permission' : 'error');
      }
    })();
    return () => controller.abort();
  }, []);

  async function runAction(action: PackageAction) {
    if (!detail || !role) return;
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    if ((action === 'abandon' || action === 'archive') && !reason.trim()) {
      setMessage('废弃或归档必须填写原因。');
      return;
    }
    setBusy(action);
    setMessage(null);
    try {
      if (action === 'generate') await generatePackage(detail, modelPolicy, csrf);
      else if (action === 'submit-review')
        await submitPackageReview(detail, selectedReviewIds, csrf);
      else await mutatePackage(detail, action, reason.trim(), csrf);
      const refreshed = await getContentPackageDetail(detail.package.id);
      applyDetail(refreshed, setDetail, setSelectedReviewIds);
      setReason('');
      setMessage(ACTION_SUCCESS[action]);
    } catch (error) {
      setMessage(
        error instanceof ContentPackageDetailRequestError && error.status === 409
          ? '状态或版本已变化，请刷新后重试。'
          : '操作失败，服务端状态守卫或依赖条件未通过。',
      );
    } finally {
      setBusy(null);
    }
  }

  if (state === 'loading')
    return <StatePanel title="正在加载内容包" text="正在读取聚合、变体和版本详情。" />;
  if (state === 'permission')
    return <StatePanel title="无权查看内容包" text="资源不存在或当前工作区未授权。" />;
  if (state === 'error' || !detail || !role)
    return <StatePanel title="无法加载内容包" text="请确认 URL 中包含有效且可访问的内容包 ID。" />;

  const producer = PRODUCER_ROLES.has(role);
  const administrator = ADMIN_ROLES.has(role);
  const guards = actionGuards(detail);
  const reviewable = new Set(detail.variants.filter(canSubmitVariant).map((item) => item.variant.id));
  const canSubmitSelection =
    selectedReviewIds.length > 0 && selectedReviewIds.every((id) => reviewable.has(id));

  return (
    <section className="mt-8 space-y-6">
      <section className="rounded-2xl border border-line bg-white p-5 shadow-panel">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="font-mono text-xs text-ink-500">{detail.package.id}</p>
            <h2 className="mt-2 text-xl font-semibold text-ink-950">
              内容包 · {shortId(detail.package.id)}
            </h2>
            <p className="mt-2 text-sm text-ink-500">
              包状态“{packageStatusLabel(detail.package.status)}”仅作摘要，所有动作按下方变体状态判断。
            </p>
          </div>
          <Link className={secondaryButton} href="/cont-03">
            返回列表
          </Link>
        </div>
      </section>

      <MasterContent content={detail.masterContent} />

      <section className="rounded-2xl border border-line bg-white p-5 shadow-panel">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-ink-950">平台变体</h2>
            <p className="mt-1 text-sm text-ink-500">引用、版本、审核和发布均以当前变体为单位。</p>
          </div>
          <span className="text-sm text-ink-500">{detail.variants.length} 个平台</span>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[1120px] text-left text-sm">
            <thead className="bg-surface-subtle text-ink-500">
              <tr>
                <th className="p-3">提交</th>
                <th className="p-3">平台</th>
                <th className="p-3">变体状态</th>
                <th className="p-3">质量</th>
                <th className="p-3">引用</th>
                <th className="p-3">版本</th>
                <th className="p-3">审核</th>
                <th className="p-3">发布</th>
                <th className="p-3">动作</th>
              </tr>
            </thead>
            <tbody>
              {detail.variants.map((item) => {
                const eligible = canSubmitVariant(item);
                return (
                  <tr className="border-t border-line" key={item.variant.id}>
                    <td className="p-3">
                      <input
                        aria-label={`提交审核：${platformLabel(item.variant.platform_code)}`}
                        checked={selectedReviewIds.includes(item.variant.id)}
                        disabled={!producer || !eligible}
                        onChange={(event) =>
                          setSelectedReviewIds((current) =>
                            event.target.checked
                              ? [...current, item.variant.id]
                              : current.filter((id) => id !== item.variant.id),
                          )
                        }
                        type="checkbox"
                      />
                    </td>
                    <td className="p-3 font-medium">{platformLabel(item.variant.platform_code)}</td>
                    <td className="p-3">{variantStatusLabel(item.variant.status)}</td>
                    <td className="p-3">
                      {item.qualityReport
                        ? `${Math.round(item.qualityReport.score)} / ${decisionLabel(item.qualityReport.decision)}`
                        : '待检查'}
                    </td>
                    <td className="p-3">
                      <CitationSummary item={item} />
                    </td>
                    <td className="p-3">
                      <VersionSummary item={item} />
                    </td>
                    <td className="p-3">{reviewLabel(item.variant.status)}</td>
                    <td className="p-3">{publishLabel(item.variant.status)}</td>
                    <td className="p-3">
                      <div className="flex gap-3">
                        <Link className="text-brand-700" href={`/cont-05?id=${item.variant.id}`}>
                          编辑
                        </Link>
                        <Link className="text-brand-700" href={`/qual-01?id=${item.variant.id}`}>
                          质量
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <GenerationRuns runs={detail.generationRuns} />

      {producer || administrator ? (
        <section className="rounded-2xl border border-line bg-white p-5 shadow-panel">
          <h2 className="text-lg font-semibold text-ink-950">内容包动作</h2>
          <p className="mt-1 text-sm text-ink-500">
            页面只提前阻止当前可见状态下的无效动作；服务端仍会重新校验版本、运行、质量和冻结依赖。
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="text-sm text-ink-700">
              生成模型策略
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
            <label className="text-sm text-ink-700">
              废弃或归档原因
              <input
                className={controlClass}
                maxLength={1000}
                onChange={(event) => setReason(event.target.value)}
                value={reason}
              />
            </label>
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            {producer ? (
              <>
                <ActionButton
                  action="generate"
                  busy={busy}
                  disabled={!guards.generate}
                  onRun={runAction}
                  text="生成内容"
                />
                <ActionButton
                  action="abandon"
                  busy={busy}
                  disabled={!guards.abandon}
                  onRun={runAction}
                  text="废弃内容包"
                />
                <ActionButton
                  action="submit-review"
                  busy={busy}
                  disabled={!canSubmitSelection}
                  onRun={runAction}
                  text="提交审核"
                />
              </>
            ) : null}
            {administrator ? (
              <ActionButton
                action="archive"
                busy={busy}
                disabled={!guards.archive}
                onRun={runAction}
                text="归档内容包"
              />
            ) : null}
          </div>
          <ul className="mt-4 list-disc space-y-1 pl-5 text-xs text-ink-500">
            <li>生成：全部必需变体可进入 generating，且没有 queued/running 运行。</li>
            <li>废弃：仅 draft 或 all_failed，且每个变体摘要与包状态一致。</li>
            <li>提交审核：仅勾选 current content 对应 pass 报告的 quality_passed 变体。</li>
            <li>归档：仅租户管理员/所有者，内容包非 archived/cancelled 且无活跃运行。</li>
          </ul>
          {message ? (
            <p aria-live="polite" className="mt-4 text-sm text-ink-700">
              {message}
            </p>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}

export function actionGuards(detail: PackageDetail) {
  const required = detail.variants.filter((item) => item.variant.is_required);
  const active = detail.generationRuns.some((run) => ACTIVE_RUNS.has(run.status));
  const terminal = ['archived', 'cancelled'].includes(detail.package.status);
  const abandon =
    !active &&
    ['draft', 'all_failed'].includes(detail.package.status) &&
    detail.variants.every((item) =>
      item.variant.is_required
        ? item.variant.status ===
          (detail.package.status === 'draft' ? 'draft' : 'generation_failed')
        : item.variant.status === 'cancelled',
    );
  return {
    abandon,
    archive: !active && !terminal,
    generate:
      !active &&
      !terminal &&
      required.length > 0 &&
      required.every((item) => GENERATABLE.has(item.variant.status)),
  };
}

function canSubmitVariant(item: VariantDetail) {
  return (
    item.variant.status === 'quality_passed' &&
    item.currentContent !== null &&
    item.qualityReport?.decision === 'pass' &&
    item.qualityReport.content_version_id === item.currentContent.id
  );
}

function MasterContent({ content }: { readonly content: PackageDetail['masterContent'] }) {
  return (
    <section className="rounded-2xl border border-line bg-white p-5 shadow-panel">
      <h2 className="text-lg font-semibold text-ink-950">母稿</h2>
      {content ? (
        <div className="mt-3">
          <p className="font-medium text-ink-950">{content.content_json.title}</p>
          <p className="mt-2 text-sm leading-6 text-ink-600">{content.content_json.summary}</p>
          <p className="mt-3 text-xs text-ink-500">
            v{content.version_no} · {content.content_json.blocks.length} 个内容块 · hash{' '}
            {content.content_hash.slice(0, 12)}
          </p>
        </div>
      ) : (
        <p className="mt-2 text-sm text-ink-500">尚未生成母稿。</p>
      )}
    </section>
  );
}

function GenerationRuns({ runs }: { readonly runs: PackageDetail['generationRuns'] }) {
  return (
    <section className="rounded-2xl border border-line bg-white p-5 shadow-panel">
      <h2 className="text-lg font-semibold text-ink-950">生成运行</h2>
      {runs.length ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="bg-surface-subtle text-ink-500">
              <tr>
                <th className="p-3">运行</th>
                <th className="p-3">Skill</th>
                <th className="p-3">模型</th>
                <th className="p-3">状态</th>
                <th className="p-3">更新时间</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr className="border-t border-line" key={run.id}>
                  <td className="p-3">
                    <Link className="text-brand-700" href={`/cont-06?id=${run.id}`}>
                      {shortId(run.id)}
                    </Link>
                  </td>
                  <td className="p-3">{run.skill_name}</td>
                  <td className="p-3">{run.model_key}</td>
                  <td className="p-3">{runStatusLabel(run.status)}</td>
                  <td className="p-3">{new Date(run.updated_at).toLocaleString('zh-CN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-2 text-sm text-ink-500">暂无生成运行。</p>
      )}
    </section>
  );
}

function CitationSummary({ item }: { readonly item: VariantDetail }) {
  if (item.citations.length === 0) return <>0 条</>;
  return (
    <details>
      <summary className="cursor-pointer text-brand-700">{item.citations.length} 条</summary>
      <ul className="mt-2 w-72 space-y-2 text-xs text-ink-600">
        {item.citations.map((citation) => (
          <li key={citation.id}>
            <p>{citation.claim_text}</p>
            <p className="mt-1 font-mono text-ink-500">chunk {shortId(citation.chunk_id)}</p>
          </li>
        ))}
      </ul>
    </details>
  );
}

function VersionSummary({ item }: { readonly item: VariantDetail }) {
  if (!item.currentContent) return <>暂无内容</>;
  return (
    <details>
      <summary className="cursor-pointer text-brand-700">
        v{item.currentContent.version_no} / 共 {item.versions.length} 版
      </summary>
      <ul className="mt-2 space-y-1 text-xs text-ink-500">
        {item.versions.map((version) => (
          <li key={version.id}>
            v{version.version_no} · {version.content_hash.slice(0, 12)}
          </li>
        ))}
      </ul>
    </details>
  );
}

function ActionButton({
  action,
  busy,
  disabled,
  onRun,
  text,
}: {
  readonly action: PackageAction;
  readonly busy: PackageAction | null;
  readonly disabled: boolean;
  readonly onRun: (action: PackageAction) => Promise<void>;
  readonly text: string;
}) {
  return (
    <button
      className={action === 'generate' || action === 'submit-review' ? primaryButton : secondaryButton}
      disabled={busy !== null || disabled}
      onClick={() => void onRun(action)}
      type="button"
    >
      {busy === action ? '处理中' : text}
    </button>
  );
}

function applyDetail(
  detail: PackageDetail,
  setDetail: (value: PackageDetail) => void,
  setSelected: (value: string[]) => void,
) {
  setDetail(detail);
  setSelected(detail.variants.filter(canSubmitVariant).map((item) => item.variant.id));
}
function isAccessError(error: unknown) {
  if (error instanceof ContentPackageDetailRequestError)
    return [401, 403, 404].includes(error.status);
  if (!error || typeof error !== 'object') return false;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === 'number' && [401, 403, 404].includes(status);
}
function readCookie(name: string) {
  const entry = document.cookie.split('; ').find((value) => value.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
}
function shortId(id: string) {
  return id.slice(0, 8);
}
function platformLabel(code: string) {
  return PLATFORM_LABELS[code] ?? code;
}
function packageStatusLabel(status: string) {
  return PACKAGE_LABELS[status] ?? status;
}
function variantStatusLabel(status: string) {
  return VARIANT_LABELS[status] ?? status;
}
function reviewLabel(status: string) {
  if (status === 'quality_passed') return '可提交';
  if (status === 'in_review') return '审核中';
  if (status === 'review_rejected') return '已退回';
  if (['review_approved', 'approved', 'scheduled', 'publishing', 'published'].includes(status))
    return '已通过';
  return '未进入';
}
function publishLabel(status: string) {
  if (status === 'published') return '已发布';
  if (status === 'publishing') return '发布中';
  if (status === 'scheduled') return '已排期';
  if (status === 'publish_failed') return '发布失败';
  if (status === 'approved') return '待排期';
  return '未就绪';
}
function decisionLabel(decision: string) {
  return { block: '阻断', pass: '通过', revise: '需修改' }[decision] ?? decision;
}
function runStatusLabel(status: string) {
  return { cancelled: '已取消', failed: '失败', queued: '排队中', running: '运行中', succeeded: '成功' }[
    status
  ] ?? status;
}
function StatePanel({ title, text }: { readonly title: string; readonly text: string }) {
  return (
    <div className="mt-5 rounded-2xl border border-line bg-white p-8 text-center shadow-panel">
      <h2 className="font-semibold text-ink-950">{title}</h2>
      <p className="mt-2 text-sm text-ink-500">{text}</p>
    </div>
  );
}

const ACTION_SUCCESS: Record<PackageAction, string> = {
  abandon: '内容包已废弃。',
  archive: '内容包已归档。',
  generate: '生成运行已创建。',
  'submit-review': '所选变体已提交审核。',
};
const PLATFORM_LABELS: Record<string, string> = {
  baijiahao: '百家号',
  douyin: '抖音',
  official_site: '官网',
  toutiao: '头条号',
  wechat_mp: '微信公众号',
  xiaohongshu: '小红书',
  zhihu: '知乎',
};
const PACKAGE_LABELS: Record<string, string> = {
  all_failed: '全部失败',
  approved: '已通过',
  archived: '已归档',
  cancelled: '已取消',
  draft: '草稿',
  editing: '编辑中',
  generated: '已生成',
  generating: '生成中',
  in_review: '审核中',
  publish_failed: '发布失败',
  published: '已发布',
  publishing: '发布中',
  rejected: '已退回',
  scheduled: '已排期',
};
const VARIANT_LABELS: Record<string, string> = {
  approved: '已批准',
  cancelled: '已取消',
  draft: '草稿',
  generated: '已生成',
  generating: '生成中',
  generation_failed: '生成失败',
  in_review: '审核中',
  publish_failed: '发布失败',
  published: '已发布',
  publishing: '发布中',
  quality_failed: '质量未通过',
  quality_passed: '质量通过',
  review_approved: '审核通过',
  review_rejected: '审核退回',
  scheduled: '已排期',
};
const controlClass =
  'mt-2 h-11 w-full rounded-control border border-line bg-white px-3 text-sm text-ink-950 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-100';
const primaryButton =
  'inline-flex h-11 items-center justify-center rounded-control bg-brand-600 px-4 text-sm font-semibold text-white disabled:opacity-50';
const secondaryButton =
  'inline-flex h-11 items-center justify-center rounded-control border border-line px-4 text-sm font-semibold text-ink-700 disabled:opacity-50';
