'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import { skillLabel } from '../human-readable';
import {
  ContentPackageDetailRequestError,
  generatePackage,
  getContentPackageDetail,
  mutatePackage,
  regenerateVariant,
  requestPackageQualityChecks,
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
  const [state, setState] = useState<
    'loading' | 'ready' | 'invalid' | 'permission' | 'unavailable'
  >('loading');
  const [busy, setBusy] = useState<PackageAction | null>(null);
  const [busyVariantId, setBusyVariantId] = useState<string | null>(null);
  const [modelPolicy, setModelPolicy] = useState<ModelPolicy>('balanced');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('id');
    if (!id || !z.string().uuid().safeParse(id).success) {
      setState('invalid');
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
        setState(isAccessError(error) ? 'permission' : 'unavailable');
      }
    })();
    return () => controller.abort();
  }, []);

  const hasActiveRun = detail?.generationRuns.some((run) => ACTIVE_RUNS.has(run.status)) ?? false;
  useEffect(() => {
    if (!detail || !hasActiveRun) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void getContentPackageDetail(detail.package.id)
        .then((refreshed) => {
          if (!cancelled) applyDetail(refreshed, setDetail, setSelectedReviewIds);
        })
        .catch(() => undefined);
    }, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [detail?.package.id, hasActiveRun]);

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
      else if (action === 'quality-check')
        await requestPackageQualityChecks(qualityCheckVariantIds(detail), csrf);
      else if (action === 'submit-review')
        await submitPackageReview(detail, selectedReviewIds, csrf);
      else await mutatePackage(detail, action, reason.trim(), csrf);
      const refreshed = await getContentPackageDetail(detail.package.id);
      applyDetail(refreshed, setDetail, setSelectedReviewIds);
      setReason('');
      setMessage(ACTION_SUCCESS[action]);
    } catch (error) {
      setMessage(actionErrorMessage(action, error));
    } finally {
      setBusy(null);
    }
  }

  async function runVariantRegeneration(item: VariantDetail) {
    if (!detail || !role) return;
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    setBusyVariantId(item.variant.id);
    setMessage(null);
    try {
      await regenerateVariant(item.variant.id, item.variant.version, modelPolicy, csrf);
      const refreshed = await getContentPackageDetail(detail.package.id);
      applyDetail(refreshed, setDetail, setSelectedReviewIds);
      setMessage(`${platformLabel(item.variant.platform_code)}内容已开始重新生成。`);
    } catch (error) {
      setMessage(actionErrorMessage('generate', error));
    } finally {
      setBusyVariantId(null);
    }
  }

  if (state === 'loading')
    return <StatePanel title="正在加载内容任务" text="正在整理各平台内容和制作进度。" />;
  if (state === 'permission')
    return <StatePanel title="无权查看这项内容" text="内容不存在，或当前工作空间未授权。" />;
  if (state === 'invalid')
    return <StatePanel title="无法打开这项内容" text="请从内容列表重新进入。" />;
  if (state === 'unavailable' || !detail || !role)
    return (
      <StatePanel
        title="内容暂时无法加载"
        text="服务暂时没有返回完整信息，请返回内容列表后重试。"
      />
    );

  const producer = PRODUCER_ROLES.has(role);
  const administrator = ADMIN_ROLES.has(role);
  const guards = actionGuards(detail);
  const reviewable = new Set(
    detail.variants.filter(canSubmitVariant).map((item) => item.variant.id),
  );
  const canSubmitSelection =
    selectedReviewIds.length > 0 && selectedReviewIds.every((id) => reviewable.has(id));
  const qualityIds = qualityCheckVariantIds(detail);
  const hasExistingContent = detail.variants.some((item) => item.currentContent !== null);
  const hasGenerationFailure = detail.variants.some(
    (item) => item.variant.status === 'generation_failed',
  );
  const title = contentTaskTitle(detail);

  return (
    <section className="mt-8 space-y-6">
      <section className="rounded-2xl border border-line bg-white p-5 shadow-panel">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold text-ink-950">{title}</h2>
            <p className="mt-2 text-sm text-ink-500">
              当前进度：{packageStatusLabel(detail.package.status)}
              。系统会按“生成、检查、审核、发布”的顺序推进。
            </p>
          </div>
          <Link className={secondaryButton} href="/cont-03">
            返回内容列表
          </Link>
        </div>
        <WorkflowStepper detail={detail} />
      </section>

      {producer || administrator ? (
        <section
          aria-labelledby="recommended-action-title"
          className="rounded-2xl border border-brand-100 bg-brand-50 p-5 shadow-panel"
        >
          <div>
            <p className="text-sm font-semibold text-brand-700">现在该做什么</p>
            <h2 className="mt-1 text-lg font-semibold text-ink-950" id="recommended-action-title">
              {recommendedActionTitle(detail, hasActiveRun, qualityIds.length, canSubmitSelection)}
            </h2>
            <p className="mt-2 text-sm leading-6 text-ink-600">
              {recommendedActionDescription(
                detail,
                hasActiveRun,
                qualityIds.length,
                canSubmitSelection,
              )}
            </p>
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            {producer && !hasExistingContent ? (
              <ActionButton
                action="generate"
                busy={busy}
                disabled={!guards.generate || busyVariantId !== null}
                onRun={runAction}
                text={hasGenerationFailure ? '重新生成失败内容' : '开始生成内容'}
              />
            ) : null}
            {producer && qualityIds.length > 0 ? (
              <ActionButton
                action="quality-check"
                busy={busy}
                disabled={hasActiveRun}
                onRun={runAction}
                text="检查内容质量"
              />
            ) : null}
            {producer && canSubmitSelection ? (
              <ActionButton
                action="submit-review"
                busy={busy}
                disabled={false}
                onRun={runAction}
                text={`提交审核（${selectedReviewIds.length}）`}
              />
            ) : null}
          </div>
          {message ? (
            <p aria-live="polite" className="mt-4 text-sm font-medium text-ink-700">
              {message}
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="rounded-2xl border border-line bg-white p-5 shadow-panel">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-ink-950">各平台内容</h2>
            <p className="mt-1 text-sm text-ink-500">
              每个平台单独显示当前结果、下一步和可执行操作。
            </p>
          </div>
          <span className="text-sm text-ink-500">{detail.variants.length} 个平台</span>
        </div>
        <div className="mt-5 grid gap-4">
          {detail.variants.map((item) => (
            <PlatformContentCard
              item={item}
              key={item.variant.id}
              failedRunId={failedGenerationRunId(detail, item.variant.id)}
              onRegenerate={() => runVariantRegeneration(item)}
              onSelectedChange={(checked) =>
                setSelectedReviewIds((current) =>
                  checked
                    ? [...current, item.variant.id]
                    : current.filter((id) => id !== item.variant.id),
                )
              }
              producer={producer}
              regenerationBusy={busyVariantId === item.variant.id}
              regenerationDisabled={hasActiveRun || busy !== null || busyVariantId !== null}
              selected={selectedReviewIds.includes(item.variant.id)}
            />
          ))}
        </div>
      </section>

      <MasterContent content={detail.masterContent} />

      <GenerationRuns runs={detail.generationRuns} variants={detail.variants} />

      {producer || administrator ? (
        <details className="group overflow-hidden rounded-2xl border border-line bg-white shadow-panel">
          <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 px-5 py-4">
            <div>
              <p className="font-semibold text-ink-950">更多设置与任务管理</p>
              <p className="mt-1 text-sm text-ink-500">重新生成、放弃和归档等低频操作放在这里。</p>
            </div>
            <span className="text-sm font-semibold text-brand-700 group-open:hidden">展开</span>
            <span className="hidden text-sm font-semibold text-brand-700 group-open:inline">
              收起
            </span>
          </summary>
          <div className="border-t border-line p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm text-ink-700">
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
              <label className="text-sm text-ink-700">
                放弃或归档原因
                <input
                  className={controlClass}
                  maxLength={1000}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="执行放弃或归档时必填"
                  value={reason}
                />
              </label>
            </div>
            <div className="mt-5 flex flex-wrap gap-3">
              {producer && hasExistingContent ? (
                <ActionButton
                  action="generate"
                  busy={busy}
                  disabled={!guards.generate}
                  onRun={runAction}
                  text="重新生成全部内容"
                />
              ) : null}
              {producer ? (
                <ActionButton
                  action="abandon"
                  busy={busy}
                  disabled={!guards.abandon}
                  onRun={runAction}
                  text="放弃本次创作"
                />
              ) : null}
              {administrator ? (
                <ActionButton
                  action="archive"
                  busy={busy}
                  disabled={!guards.archive}
                  onRun={runAction}
                  text="归档任务"
                />
              ) : null}
            </div>
          </div>
        </details>
      ) : null}
    </section>
  );
}

function WorkflowStepper({ detail }: { readonly detail: PackageDetail }) {
  const current = workflowStep(detail);
  const steps = ['生成内容', '质量检查', '审核确认', '安排发布'];
  return (
    <ol aria-label="内容处理步骤" className="mt-5 grid gap-2 sm:grid-cols-4">
      {steps.map((label, index) => {
        const completed = current > index;
        const active = current === index;
        return (
          <li
            aria-current={active ? 'step' : undefined}
            className={`rounded-xl border px-3 py-3 text-sm font-medium ${
              completed
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                : active
                  ? 'border-brand-200 bg-brand-50 text-brand-700'
                  : 'border-line bg-surface-subtle text-ink-500'
            }`}
            key={label}
          >
            <span className="mr-2">{completed ? '✓' : index + 1}</span>
            {label}
          </li>
        );
      })}
    </ol>
  );
}

function workflowStep(detail: PackageDetail): number {
  const statuses = detail.variants.map((item) => item.variant.status);
  if (statuses.length > 0 && statuses.every((status) => status === 'published')) return 4;
  if (
    statuses.some((status) =>
      ['approved', 'publish_failed', 'published', 'publishing', 'scheduled'].includes(status),
    )
  )
    return 3;
  if (
    statuses.some((status) => ['in_review', 'review_approved', 'review_rejected'].includes(status))
  )
    return 2;
  if (detail.variants.some((item) => item.currentContent !== null)) return 1;
  return 0;
}

function recommendedActionTitle(
  detail: PackageDetail,
  hasActiveRun: boolean,
  qualityCount: number,
  canSubmitSelection: boolean,
): string {
  if (hasActiveRun) return '系统正在处理，请稍候';
  if (!detail.variants.some((item) => item.currentContent))
    return detail.variants.some((item) => item.variant.status === 'generation_failed')
      ? '处理生成失败的内容'
      : '生成各平台内容';
  if (detail.variants.some((item) => item.automationRun?.status === 'manual_required'))
    return '处理未通过机器检查的官网内容';
  if (detail.variants.some((item) => item.automationRun?.status === 'publish_failed'))
    return '处理官网发布失败';
  if (qualityCount > 0) return '检查已生成内容的质量';
  if (canSubmitSelection) return '提交已通过检查的内容';
  if (detail.variants.some((item) => item.variant.status === 'in_review')) return '等待审核结果';
  if (detail.variants.some((item) => item.variant.status === 'approved')) return '安排内容发布';
  if (detail.variants.every((item) => item.variant.status === 'published')) return '本次内容已完成';
  return '查看各平台的处理进度';
}

function recommendedActionDescription(
  detail: PackageDetail,
  hasActiveRun: boolean,
  qualityCount: number,
  canSubmitSelection: boolean,
): string {
  if (hasActiveRun) return '完成后页面会自动更新，无需重复点击。';
  if (!detail.variants.some((item) => item.currentContent))
    return detail.variants.some((item) => item.variant.status === 'generation_failed')
      ? '在下方失败的平台卡片中查看原因，或直接重新生成该平台内容。'
      : '点击开始后，系统会为所选平台分别生成适配内容。';
  if (detail.variants.some((item) => item.automationRun?.status === 'manual_required'))
    return '自动重写达到上限。请在下方找到官网内容，查看问题并编辑后重新检查。';
  if (detail.variants.some((item) => item.automationRun?.status === 'publish_failed'))
    return '内容已经通过机器检查，但官网接口发布失败。请从官网平台卡片进入失败任务重试。';
  if (qualityCount > 0) return `有 ${qualityCount} 个平台内容需要检查，检查通过后才能进入下一步。`;
  if (canSubmitSelection) return '已通过检查的平台已经为你选中，确认后即可提交审核。';
  if (detail.variants.some((item) => item.variant.status === 'in_review'))
    return '内容已交给审核人员，你可以在审核完成后继续安排发布。';
  if (detail.variants.some((item) => item.variant.status === 'approved'))
    return '审核已经通过，请在对应平台卡片中点击“安排发布”。';
  if (detail.variants.every((item) => item.variant.status === 'published'))
    return '所有平台内容均已发布，可以返回内容列表开始下一项创作。';
  return '每个平台卡片会说明当前状态以及可以执行的下一步。';
}

function PlatformContentCard({
  failedRunId,
  item,
  onRegenerate,
  onSelectedChange,
  producer,
  regenerationBusy,
  regenerationDisabled,
  selected,
}: {
  readonly failedRunId: string | null;
  readonly item: VariantDetail;
  readonly onRegenerate: () => Promise<void>;
  readonly onSelectedChange: (checked: boolean) => void;
  readonly producer: boolean;
  readonly regenerationBusy: boolean;
  readonly regenerationDisabled: boolean;
  readonly selected: boolean;
}) {
  const platform = platformLabel(item.variant.platform_code);
  const eligible = canSubmitVariant(item);
  const automationLabel = item.automationRun
    ? automationStatusLabel(item.automationRun.status, item.automationRun.rewrite_count)
    : null;
  return (
    <article className="rounded-2xl border border-line bg-surface-subtle p-4 sm:p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-lg font-semibold text-ink-950">{platform}</h3>
            <span className={variantStatusClass(item.variant.status)}>
              {variantStatusLabel(item.variant.status)}
            </span>
            {item.automationRun ? (
              <span className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700">
                机器检查后自动发布
              </span>
            ) : null}
          </div>
          <p className="mt-2 text-sm leading-6 text-ink-600">{variantNextStep(item)}</p>
          {item.currentContent ? (
            <div className="mt-4 rounded-xl border border-line bg-white p-4">
              <p className="font-medium text-ink-950">{item.currentContent.content_json.title}</p>
              <p className="mt-2 line-clamp-2 text-sm leading-6 text-ink-600">
                {item.currentContent.content_json.summary}
              </p>
            </div>
          ) : null}
        </div>

        <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-3 lg:w-[430px]">
          <div className="rounded-xl bg-white p-3">
            <dt className="text-xs text-ink-500">质量检查</dt>
            <dd className="mt-1 font-medium text-ink-800">
              {item.qualityReport
                ? `${Math.round(item.qualityReport.score)} 分 · ${decisionLabel(item.qualityReport.decision)}`
                : '尚未检查'}
            </dd>
          </div>
          <div className="rounded-xl bg-white p-3">
            <dt className="text-xs text-ink-500">审核</dt>
            <dd className="mt-1 font-medium text-ink-800">
              {item.automationRun ? '无需人工审核' : reviewLabel(item.variant.status)}
            </dd>
          </div>
          <div className="rounded-xl bg-white p-3">
            <dt className="text-xs text-ink-500">发布</dt>
            <dd className="mt-1 font-medium text-ink-800">
              {automationLabel ?? publishLabel(item.variant.status)}
            </dd>
          </div>
        </dl>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4">
        {item.variant.status === 'generation_failed' ? (
          <Link
            className={secondaryButton}
            href={failedRunId ? `/cont-06?id=${failedRunId}` : '#processing-records'}
          >
            查看失败原因
          </Link>
        ) : null}
        {producer && item.variant.status === 'generation_failed' ? (
          <button
            className={primaryButton}
            disabled={regenerationDisabled}
            onClick={() => void onRegenerate()}
            type="button"
          >
            {regenerationBusy ? '重新生成中' : `重新生成${platform}内容`}
          </button>
        ) : null}
        {producer && eligible ? (
          <label className="inline-flex min-h-10 items-center gap-2 rounded-control border border-brand-200 bg-white px-3 text-sm font-medium text-brand-700">
            <input
              aria-label={`提交审核：${platform}`}
              checked={selected}
              onChange={(event) => onSelectedChange(event.target.checked)}
              type="checkbox"
            />
            选择提交审核
          </label>
        ) : null}
        {item.currentContent ? (
          <Link className={secondaryButton} href={`/cont-05?id=${item.variant.id}`}>
            编辑内容
          </Link>
        ) : null}
        {item.currentContent ? (
          <Link className={secondaryButton} href={`/qual-01?id=${item.variant.id}`}>
            {item.automationRun?.status === 'manual_required'
              ? '查看问题并处理'
              : item.qualityReport
                ? '查看检查结果'
                : '检查质量'}
          </Link>
        ) : null}
        {item.automationRun?.status === 'publish_failed' && item.automationRun.publish_job_id ? (
          <Link className={primaryButton} href={`/pub-03?id=${item.automationRun.publish_job_id}`}>
            查看失败并重试
          </Link>
        ) : null}
        {item.variant.status === 'approved' ? (
          <Link className={primaryButton} href={`/pub-02?variant_id=${item.variant.id}`}>
            安排发布
          </Link>
        ) : null}
        {item.currentContent ? (
          <details className="ml-auto w-full text-sm sm:w-auto">
            <summary className="cursor-pointer py-2 font-medium text-brand-700">
              查看版本与事实依据
            </summary>
            <div className="mt-2 grid gap-4 rounded-xl border border-line bg-white p-4 sm:min-w-[420px] sm:grid-cols-2">
              <div>
                <p className="mb-2 text-xs font-semibold text-ink-500">版本记录</p>
                <VersionSummary item={item} />
              </div>
              <div>
                <p className="mb-2 text-xs font-semibold text-ink-500">事实依据</p>
                <CitationSummary item={item} />
              </div>
            </div>
          </details>
        ) : null}
      </div>
      <FailureDiagnostics item={item} />
    </article>
  );
}

function FailureDiagnostics({ item }: { readonly item: VariantDetail }) {
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const failed =
    item.currentContent !== null &&
    (item.automationRun?.status === 'manual_required' ||
      ['generation_failed', 'quality_failed', 'review_rejected'].includes(item.variant.status));
  if (!failed) return null;

  async function copyDiagnostics() {
    const payload = {
      automation_run: item.automationRun,
      citations: item.citations,
      current_content_version_id: item.currentContent?.id ?? null,
      platform_code: item.variant.platform_code,
      quality_reports: item.qualityReports,
      variant_id: item.variant.id,
      variant_status: item.variant.status,
      versions: item.versions.map((version) => ({
        content_hash: version.content_hash,
        content_json: version.content_json,
        created_at: version.created_at,
        id: version.id,
        source_run_id: version.source_run_id,
        version_no: version.version_no,
      })),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopyMessage('诊断信息已复制。');
    } catch {
      setCopyMessage('复制失败，请检查浏览器剪贴板权限。');
    }
  }

  return (
    <details className="group mt-4 overflow-hidden rounded-xl border border-red-200 bg-red-50/40">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
        <div>
          <p className="font-semibold text-red-800">查看失败全文与诊断</p>
          <p className="mt-1 text-xs text-red-700">
            包含最后一版全文、每次重写版本及对应质量问题。
          </p>
        </div>
        <span className="text-sm font-semibold text-red-700 group-open:hidden">展开</span>
        <span className="hidden text-sm font-semibold text-red-700 group-open:inline">收起</span>
      </summary>
      <div className="space-y-4 border-t border-red-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-ink-600">
            共 {item.versions.length} 个正文版本、{item.qualityReports.length} 份质量报告
          </p>
          <button className={secondaryButton} onClick={() => void copyDiagnostics()} type="button">
            复制诊断信息
          </button>
        </div>
        {copyMessage ? (
          <p aria-live="polite" className="text-sm text-ink-600">
            {copyMessage}
          </p>
        ) : null}
        {item.automationRun?.last_error ? (
          <div className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
            <p className="font-semibold">最终失败原因</p>
            <p className="mt-1">{automationErrorSummary(item.automationRun.last_error)}</p>
          </div>
        ) : null}
        <div className="space-y-3">
          {item.versions.map((version) => {
            const reports = item.qualityReports.filter(
              (report) => report.content_version_id === version.id,
            );
            const current = version.id === item.currentContent?.id;
            return (
              <details
                className="rounded-lg border border-line bg-surface-subtle"
                key={version.id}
                open={current}
              >
                <summary className="cursor-pointer px-4 py-3 font-medium text-ink-900">
                  第 {version.version_no} 版{current ? '（最后一版）' : ''} ·{' '}
                  {reports.length ? `${reports.length} 份质量报告` : '未产生质量报告'}
                </summary>
                <div className="space-y-4 border-t border-line bg-white p-4">
                  <div>
                    <p className="font-semibold text-ink-950">{version.content_json.title}</p>
                    <p className="mt-2 text-sm leading-6 text-ink-600">
                      {version.content_json.summary}
                    </p>
                    <div className="mt-4 whitespace-pre-wrap text-sm leading-7 text-ink-800">
                      {contentVersionFullText(version)}
                    </div>
                  </div>
                  {reports.map((report) => (
                    <div className="rounded-lg border border-line p-3" key={report.id}>
                      <p className="text-sm font-semibold text-ink-900">
                        质量报告：{Math.round(report.score)} 分 · {decisionLabel(report.decision)}
                      </p>
                      {qualityGateRuleSummary(report.automation_gate) ? (
                        <p className="mt-2 text-sm text-red-700">
                          门禁阻断规则：{qualityGateRuleSummary(report.automation_gate)}
                        </p>
                      ) : null}
                      {report.issues.length ? (
                        <ul className="mt-3 space-y-2 text-sm text-ink-700">
                          {report.issues.map((issue, index) => (
                            <li key={`${issue.rule_id}-${issue.location ?? ''}-${index}`}>
                              <span className="font-medium">{issue.rule_id}</span>：{issue.message}
                              {issue.suggestion ? `；建议：${issue.suggestion}` : ''}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-2 text-sm text-ink-500">该报告没有问题明细。</p>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            );
          })}
        </div>
      </div>
    </details>
  );
}

function contentVersionFullText(version: VariantDetail['versions'][number]): string {
  return version.content_json.blocks
    .flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const text = (value as Readonly<Record<string, unknown>>)['text'];
      return typeof text === 'string' && text.trim() ? [text.trim()] : [];
    })
    .join('\n\n');
}

function automationErrorSummary(value: Readonly<Record<string, unknown>>): string {
  const code = typeof value['code'] === 'string' ? value['code'] : 'UNKNOWN';
  const rules = Array.isArray(value['blocking_rules'])
    ? value['blocking_rules'].filter((item): item is string => typeof item === 'string')
    : [];
  const message = typeof value['message'] === 'string' ? value['message'] : '';
  return [code, rules.length ? `阻断规则：${rules.join('、')}` : '', message]
    .filter(Boolean)
    .join('；');
}

function qualityGateRuleSummary(value: Readonly<Record<string, unknown>> | null): string {
  if (!value || !Array.isArray(value['blocking_rules'])) return '';
  return value['blocking_rules']
    .filter((item): item is string => typeof item === 'string')
    .join('、');
}

function variantNextStep(item: VariantDetail): string {
  if (item.automationRun?.status === 'manual_required')
    return '机器检查连续未通过，需要查看具体问题并修改内容。';
  if (item.automationRun?.status === 'publish_failed')
    return '内容已通过检查，但发布到官网失败，需要重试。';
  if (
    item.automationRun &&
    ['publish_pending', 'publishing', 'quality_pending', 'rewrite_pending', 'rewriting'].includes(
      item.automationRun.status,
    )
  )
    return '系统正在自动检查、重写或发布，无需人工操作。';
  if (item.variant.status === 'generation_failed') return '内容生成失败，可以重新生成全部内容。';
  if (!item.currentContent) return '尚未生成内容。';
  if (['generated', 'quality_failed'].includes(item.variant.status))
    return '内容已经生成，下一步检查质量。';
  if (item.variant.status === 'quality_passed') return '质量检查已通过，可以提交审核。';
  if (item.variant.status === 'in_review') return '内容正在审核，请等待结果。';
  if (item.variant.status === 'review_rejected') return '审核已退回，请编辑后重新检查。';
  if (item.variant.status === 'approved') return '审核已通过，可以安排发布。';
  if (item.variant.status === 'publish_failed') return '发布失败，请进入发布任务查看原因并重试。';
  if (item.variant.status === 'published') return '内容已经发布。';
  return '请根据当前状态继续处理。';
}

function variantStatusClass(status: string): string {
  if (['published', 'quality_passed', 'review_approved', 'approved'].includes(status))
    return 'rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700';
  if (['generation_failed', 'publish_failed', 'quality_failed', 'review_rejected'].includes(status))
    return 'rounded-full bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-700';
  if (['generating', 'in_review', 'publishing', 'scheduled'].includes(status))
    return 'rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700';
  return 'rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-ink-600';
}

function actionErrorMessage(action: PackageAction, error: unknown): string {
  if (!(error instanceof ContentPackageDetailRequestError)) {
    return '操作失败，请稍后重试。';
  }
  if (error.status === 409) return '状态或版本已变化，请刷新后重试。';
  if (action === 'generate' && error.status === 422) {
    return '生成条件未满足。请确认当前工作区已有已发布品牌策略，并检查模型与平台规则配置。';
  }
  if (action === 'quality-check' && error.status === 422) {
    return '质量检查尚未配置完整，请确认质量模型和检查规则已启用。';
  }
  if (error.status >= 500) return '服务暂时不可用，请稍后重试。';
  return '操作失败，当前状态或依赖条件不允许执行。';
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
    item.automationRun === null &&
    item.variant.status === 'quality_passed' &&
    item.currentContent !== null &&
    item.qualityReport?.decision === 'pass' &&
    item.qualityReport.content_version_id === item.currentContent.id
  );
}

function MasterContent({ content }: { readonly content: PackageDetail['masterContent'] }) {
  return (
    <details className="group overflow-hidden rounded-2xl border border-line bg-white shadow-panel">
      <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 px-5 py-4">
        <div>
          <h2 className="font-semibold text-ink-950">查看通用初稿</h2>
          <p className="mt-1 text-sm text-ink-500">平台内容会在这份初稿基础上分别适配。</p>
        </div>
        <span className="text-sm font-semibold text-brand-700 group-open:hidden">展开</span>
        <span className="hidden text-sm font-semibold text-brand-700 group-open:inline">收起</span>
      </summary>
      <div className="border-t border-line p-5">
        {content ? (
          <div>
            <p className="font-medium text-ink-950">{content.content_json.title}</p>
            <p className="mt-2 text-sm leading-6 text-ink-600">{content.content_json.summary}</p>
            <p className="mt-3 text-xs text-ink-500">
              共 {content.content_json.blocks.length} 段正文
            </p>
          </div>
        ) : (
          <p className="text-sm text-ink-500">通用初稿正在准备，平台内容完成后会在这里汇总。</p>
        )}
      </div>
    </details>
  );
}

function GenerationRuns({
  runs,
  variants,
}: {
  readonly runs: PackageDetail['generationRuns'];
  readonly variants: PackageDetail['variants'];
}) {
  return (
    <details
      className="group overflow-hidden rounded-2xl border border-line bg-white shadow-panel"
      id="processing-records"
    >
      <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 px-5 py-4">
        <div>
          <h2 className="font-semibold text-ink-950">处理记录</h2>
          <p className="mt-1 text-sm text-ink-500">
            查看系统执行过的生成和检查记录，共 {runs.length} 条。
          </p>
        </div>
        <span className="text-sm font-semibold text-brand-700 group-open:hidden">展开</span>
        <span className="hidden text-sm font-semibold text-brand-700 group-open:inline">收起</span>
      </summary>
      <div className="border-t border-line p-5">
        {runs.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-surface-subtle text-ink-500">
                <tr>
                  <th className="p-3">处理内容</th>
                  <th className="p-3">状态</th>
                  <th className="p-3">更新时间</th>
                  <th className="p-3">操作</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const variant = variants.find((item) => item.variant.id === run.variant_id);
                  return (
                    <tr className="border-t border-line" key={run.id}>
                      <td className="p-3">
                        {variant
                          ? variantRunLabel(run.skill_name, variant.variant.platform_code)
                          : skillLabel(run.skill_name)}
                      </td>
                      <td className="p-3">{runStatusLabel(run.status)}</td>
                      <td className="p-3">{new Date(run.updated_at).toLocaleString('zh-CN')}</td>
                      <td className="p-3">
                        <Link className="text-brand-700" href={`/cont-06?id=${run.id}`}>
                          查看详情
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-ink-500">还没有处理记录。</p>
        )}
      </div>
    </details>
  );
}

function failedGenerationRunId(detail: PackageDetail, variantId: string): string | null {
  return (
    detail.generationRuns.find(
      (run) =>
        run.variant_id === variantId &&
        run.skill_name === 'content-writer' &&
        run.status === 'failed',
    )?.id ?? null
  );
}

function variantRunLabel(skillName: string, platformCode: string): string {
  const platform = platformLabel(platformCode);
  if (skillName === 'quality-checker') return `检查${platform}内容质量`;
  if (skillName === 'content-writer') return `生成${platform}内容`;
  return `${skillLabel(skillName)}（${platform}）`;
}

function CitationSummary({ item }: { readonly item: VariantDetail }) {
  if (item.citations.length === 0) return <>0 条</>;
  return (
    <details>
      <summary className="cursor-pointer text-brand-700">{item.citations.length} 条</summary>
      <ul className="mt-2 space-y-2 text-xs text-ink-600">
        {item.citations.map((citation) => (
          <li key={citation.id}>
            <p>{citation.claim_text}</p>
            <p className="mt-1 text-ink-500">依据：{citation.quote_text}</p>
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
            第 {version.version_no} 版 · {new Date(version.created_at).toLocaleString('zh-CN')}
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
      className={
        action === 'generate' || action === 'quality-check' || action === 'submit-review'
          ? primaryButton
          : secondaryButton
      }
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
function qualityCheckVariantIds(detail: PackageDetail) {
  return detail.variants
    .filter((item) => {
      if (item.automationRun) {
        return (
          item.automationRun.status === 'manual_required' &&
          item.currentContent !== null &&
          item.variant.status === 'quality_failed'
        );
      }
      return (
        item.currentContent !== null &&
        ['generated', 'quality_failed', 'quality_passed'].includes(item.variant.status) &&
        !(
          item.variant.status === 'quality_passed' &&
          item.qualityReport?.decision === 'pass' &&
          item.qualityReport.content_version_id === item.currentContent.id
        )
      );
    })
    .map((item) => item.variant.id);
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
function contentTaskTitle(detail: PackageDetail) {
  return (
    detail.masterContent?.content_json.title ||
    detail.variants.find((item) => item.currentContent)?.currentContent?.content_json.title ||
    '新内容创作'
  );
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
function automationStatusLabel(status: string, rewriteCount: number) {
  const labels: Record<string, string> = {
    disabled: '自动发布已关闭',
    manual_required: `需人工处理（已重写 ${rewriteCount}/3 次）`,
    publish_failed: '官网发布失败',
    publish_pending: '等待发布',
    published: '已自动发布',
    publishing: '正在自动发布',
    quality_pending: '正在机器质检',
    rewrite_pending: `等待第 ${rewriteCount} 次重写`,
    rewriting: `正在第 ${rewriteCount} 次重写`,
  };
  return labels[status] ?? status;
}
function decisionLabel(decision: string) {
  return { block: '阻断', pass: '通过', revise: '需修改' }[decision] ?? decision;
}
function runStatusLabel(status: string) {
  return (
    { cancelled: '已取消', failed: '失败', queued: '排队中', running: '运行中', succeeded: '成功' }[
      status
    ] ?? status
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

const ACTION_SUCCESS: Record<PackageAction, string> = {
  abandon: '本次创作已放弃。',
  archive: '内容任务已归档。',
  generate: '内容生成已开始。',
  'quality-check': '质量检查已开始，完成后页面会自动刷新。',
  'submit-review': '所选平台内容已提交审核。',
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
