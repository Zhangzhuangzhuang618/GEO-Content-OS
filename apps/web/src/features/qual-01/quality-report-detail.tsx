'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import { TechnicalDetails } from '../human-readable';
import {
  getQualityVariantDetail,
  QualityReportRequestError,
  regenerateQualityVariant,
  requestQualityCheck,
  submitQualityPassedVariant,
} from './quality-report-api';
import type { QualityIssue, QualityVariantDetail } from './quality-report.schema';

const WRITE_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'content_editor']);
const RECHECK_STATUSES = new Set(['generated', 'quality_failed', 'quality_passed']);
const REGENERATE_STATUSES = new Set([
  'generated',
  'generation_failed',
  'quality_failed',
  'quality_passed',
  'review_rejected',
]);

export function QualityReportDetail() {
  const [detail, setDetail] = useState<QualityVariantDetail | null>(null);
  const [role, setRole] = useState<TenantRole | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'permission'>('loading');
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [regenerationStarted, setRegenerationStarted] = useState(false);
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
          getQualityVariantDetail(id, controller.signal),
        ]);
        const activeRole = tenants.find((tenant) => tenant.is_active)?.role_code ?? null;
        if (!activeRole) {
          setState('permission');
          return;
        }
        setRole(activeRole);
        setDetail(loaded);
        setState('ready');
      } catch (error) {
        if (controller.signal.aborted) return;
        setState(isAccessError(error) ? 'permission' : 'error');
      }
    })();
    return () => controller.abort();
  }, []);

  const waitingVariantId = detail?.variant.id;
  useEffect(() => {
    if (!waiting || !waitingVariantId) return;
    let cancelled = false;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      void getQualityVariantDetail(waitingVariantId)
        .then((refreshed) => {
          if (cancelled) return;
          setDetail(refreshed);
          if (refreshed.quality_report) {
            setWaiting(false);
            setMessage('质量检查已完成。');
          } else if (Date.now() - startedAt > 5 * 60_000) {
            setWaiting(false);
            setMessage('质量检查耗时较长，请稍后重新打开本页查看结果。');
          }
        })
        .catch(() => undefined);
    }, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [waiting, waitingVariantId]);

  async function recheck() {
    if (!detail) return;
    const started = await mutate(
      (csrf) => requestQualityCheck(detail.variant.id, csrf),
      '质量检查已开始，完成后页面会自动刷新。',
    );
    if (started) setWaiting(true);
  }

  async function submitReview() {
    if (!detail) return;
    await mutate(
      (csrf) => submitQualityPassedVariant(detail.variant.package_id, detail.variant.id, csrf),
      '内容已提交审核。',
    );
  }

  async function regenerate() {
    if (!detail) return;
    const started = await mutate(
      (csrf) =>
        regenerateQualityVariant(
          detail.variant.id,
          detail.variant.version,
          detail.locks.map((lock) => lock.block_key),
          csrf,
        ),
      detail.variant.platform_code === 'official_site' ||
        detail.variant.platform_code === 'baijiahao'
        ? '重新生成已开始；生成成功后系统会自动继续质量检查。'
        : '重新生成已开始；完成后请重新进行质量检查。',
    );
    if (started) setRegenerationStarted(true);
  }

  async function copyHumanReviewRequest() {
    if (!detail?.quality_report) return;
    const report = detail.quality_report;
    const factIssues = report.issues.filter((issue) => issue.category === 'fact');
    const citationIds = new Set(factIssues.flatMap((issue) => issue.citation_ids));
    const payload = {
      claims: detail.citations
        .filter((citation) => citationIds.has(citation.id))
        .map((citation) => ({
          claim_key: citation.claim_key,
          claim_text: citation.claim_text,
          evidence: citation.quote_text,
        })),
      quality_report_id: report.id,
      reason: factIssues.map((issue) => issue.message).join('；'),
      variant_id: detail.variant.id,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setMessage('事实复核摘要已复制，可发送给负责确认的同事。');
    } catch {
      setMessage('无法复制裁决请求摘要，请检查浏览器剪贴板权限。');
    }
  }

  async function mutate(work: (csrf: string) => Promise<void>, success: string) {
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return false;
    }
    setBusy(true);
    setMessage(null);
    try {
      await work(csrf);
      setMessage(success);
      return true;
    } catch {
      setMessage('操作失败，请检查当前状态或稍后重试。');
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (state === 'loading')
    return <StatePanel title="正在加载质量报告" text="正在读取报告、问题和引用证据。" />;
  if (state === 'permission')
    return <StatePanel title="无权查看质量报告" text="需要当前企业的有效成员身份。" />;
  if (state === 'error' || !detail)
    return (
      <StatePanel
        title="无法加载质量报告"
        text="这份内容可能已失效、被删除或不在你的权限范围内。"
      />
    );
  const canWrite = Boolean(role && WRITE_ROLES.has(role));
  const canRecheck = canWrite && RECHECK_STATUSES.has(detail.variant.status);
  const canRegenerate =
    canWrite &&
    REGENERATE_STATUSES.has(detail.variant.status) &&
    (detail.variant.is_required ||
      (detail.variant.platform_code === 'baijiahao' && Boolean(detail.automation_run)));
  if (!detail.quality_report)
    return (
      <section className="mt-8 rounded-2xl border border-line bg-white p-8 text-center shadow-panel">
        <h2 className="text-xl font-semibold text-ink-950">
          {waiting ? '正在检查内容质量' : '这份内容还没有质量报告'}
        </h2>
        <p className="mt-3 text-sm leading-6 text-ink-500">
          {waiting
            ? '系统正在检查事实边界、品牌规则、平台格式和可读性，完成后会自动显示结果。'
            : '开始检查后，系统会给出分数和具体修改建议；检查通过后才能提交审核。'}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link className={secondaryButton} href={`/cont-05?id=${detail.variant.id}`}>
            返回编辑内容
          </Link>
          <button
            className={primaryButton}
            disabled={busy || waiting || !canRecheck}
            onClick={() => void recheck()}
            type="button"
          >
            {waiting ? '检查中…' : '开始质量检查'}
          </button>
        </div>
        {!canWrite ? (
          <p className="mt-4 text-xs text-ink-500">当前账号只有查看权限，无法发起检查。</p>
        ) : null}
        {message ? (
          <p aria-live="polite" className="mt-4 text-sm text-ink-600">
            {message}
          </p>
        ) : null}
      </section>
    );

  const report = detail.quality_report;
  const canSubmit =
    canWrite && report.decision === 'pass' && detail.variant.status === 'quality_passed';
  const factIssues = report.issues.filter((issue) => issue.category === 'fact');

  return (
    <section className="mt-8 space-y-6">
      <section className="rounded-2xl border border-line bg-white p-5 shadow-panel sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <div className="flex items-end gap-3">
              <strong className="text-5xl font-semibold tracking-tight text-ink-950">
                {Math.round(report.score)}
              </strong>
              <span className="pb-1 text-sm text-ink-500">/ 100</span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className={decisionClass(report.decision)}>
                {decisionLabel(report.decision)}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link className={secondaryButton} href={`/cont-05?id=${detail.variant.id}`}>
              返回内容编辑器
            </Link>
            <button
              className={secondaryButton}
              disabled={busy || !canRecheck}
              onClick={() => void recheck()}
              type="button"
            >
              重新检查
            </button>
            {report.decision !== 'pass' ? (
              <button
                className={secondaryButton}
                disabled={busy || regenerationStarted || !canRegenerate}
                onClick={() => void regenerate()}
                type="button"
              >
                {regenerationStarted ? '重新生成中…' : '重新生成内容'}
              </button>
            ) : null}
            <button
              className={primaryButton}
              disabled={busy || !canSubmit}
              onClick={() => void submitReview()}
              type="button"
            >
              提交审核
            </button>
          </div>
        </div>
        {report.decision !== 'pass' ? (
          <p className="mt-5 rounded-xl bg-amber-50 p-4 text-sm text-amber-900">
            {report.decision === 'block'
              ? '发现必须修改的问题，处理完后才能提交审核。'
              : '建议先处理下方问题，再重新检查并提交审核。'}
          </p>
        ) : null}
        <TechnicalDetails summary="检查技术信息">
          <p>检查器版本：{report.checker_version}</p>
          <p>质量报告：{report.id}</p>
          <p>内容版本：{report.content_version_id}</p>
        </TechnicalDetails>
        {message ? (
          <p aria-live="polite" className="mt-4 text-sm text-ink-600">
            {message}
          </p>
        ) : null}
      </section>

      <Panel title="质量细分" subtitle="各项均为 0–100 分，帮助定位需要改进的方向。">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {GEO_SCORE_LABELS.map(([key, label]) => (
            <Score key={key} label={label} value={report.geo_scores[key]} />
          ))}
        </div>
      </Panel>

      <Panel
        title={`问题（${report.issues.length}）`}
        subtitle="按影响程度排列；必须修改的问题会阻止内容进入审核。"
      >
        {report.issues.length > 0 ? (
          <div className="space-y-3">
            {report.issues.map((issue) => (
              <IssueCard
                canLocate={canWrite}
                issue={issue}
                key={`${issue.rule_id}-${issue.location ?? 'global'}`}
                variantId={detail.variant.id}
              />
            ))}
          </div>
        ) : (
          <Empty text="报告没有记录问题。" />
        )}
      </Panel>

      <Panel title="事实依据" subtitle="展示内容中的事实声明及其资料依据。">
        {detail.citations.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2">
            {detail.citations.map((citation) => (
              <article
                className="rounded-xl border border-line p-4"
                id={`citation-${citation.id}`}
                key={citation.id}
              >
                <h3 className="font-semibold text-ink-950">{citation.claim_text}</h3>
                <blockquote className="mt-3 border-l-2 border-brand-200 pl-3 text-sm leading-6 text-ink-600">
                  {citation.quote_text}
                </blockquote>
              </article>
            ))}
          </div>
        ) : (
          <Empty text="当前内容版本没有持久化引用证据。" />
        )}
      </Panel>

      <Panel title="需要人工确认的事实" subtitle="将争议事实和对应资料整理后交给同事确认。">
        <button
          className={secondaryButton}
          disabled={busy || factIssues.length === 0}
          onClick={() => void copyHumanReviewRequest()}
          type="button"
        >
          复制事实复核摘要
        </button>
        <p className="mt-3 text-xs leading-5 text-ink-500">
          复制后可通过企业现有的沟通或审批流程发送给负责人。
        </p>
      </Panel>
    </section>
  );
}

function IssueCard({
  canLocate,
  issue,
  variantId,
}: {
  readonly canLocate: boolean;
  readonly issue: QualityIssue;
  readonly variantId: string;
}) {
  const target = issue.location ? `&focus_block=${encodeURIComponent(issue.location)}` : '';
  return (
    <article className="rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={severityClass(issue.severity)}>{severityLabel(issue.severity)}</span>
        <span className="text-xs text-ink-500">{categoryLabel(issue.category)}</span>
      </div>
      <p className="mt-3 text-sm font-medium text-ink-950">{issue.message}</p>
      {issue.suggestion ? (
        <p className="mt-2 text-sm text-ink-600">建议：{issue.suggestion}</p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-ink-500">
        <span>{issue.location ? '可直接定位到对应段落' : '影响全文'}</span>
        {canLocate && issue.location ? (
          <Link
            className="font-semibold text-brand-700"
            href={`/cont-05?id=${variantId}${target}#block-${issue.location}`}
          >
            定位问题
          </Link>
        ) : null}
        {issue.citation_ids.map((id) => (
          <a className="font-semibold text-brand-700" href={`#citation-${id}`} key={id}>
            查看证据
          </a>
        ))}
      </div>
      <TechnicalDetails summary="问题技术信息">
        <p>规则：{issue.rule_id}</p>
        <p>位置：{issue.location ?? '全文'}</p>
      </TechnicalDetails>
    </article>
  );
}

function Score({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div className="rounded-xl bg-ink-50 p-4">
      <p className="text-xs text-ink-500">{label}</p>
      <p className="mt-2 text-xl font-semibold text-ink-950">{Math.round(value)}</p>
    </div>
  );
}
function Panel({
  children,
  subtitle,
  title,
}: {
  readonly children: React.ReactNode;
  readonly subtitle: string;
  readonly title: string;
}) {
  return (
    <section className="rounded-2xl border border-line bg-white p-5 shadow-panel sm:p-6">
      <h2 className="text-lg font-semibold text-ink-950">{title}</h2>
      <p className="mt-1 text-sm text-ink-500">{subtitle}</p>
      <div className="mt-5">{children}</div>
    </section>
  );
}
function Empty({ text }: { readonly text: string }) {
  return <p className="rounded-xl bg-ink-50 p-4 text-sm text-ink-500">{text}</p>;
}
function StatePanel({ title, text }: { readonly title: string; readonly text: string }) {
  return (
    <div className="mt-8 rounded-2xl border border-line bg-white p-8 text-center shadow-panel">
      <h2 className="font-semibold text-ink-950">{title}</h2>
      <p className="mt-2 text-sm text-ink-500">{text}</p>
    </div>
  );
}
function readCookie(name: string) {
  const entry = document.cookie.split('; ').find((value) => value.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
}
function isAccessError(error: unknown) {
  return error instanceof QualityReportRequestError && [401, 403, 404].includes(error.status);
}
function decisionLabel(value: string) {
  return { block: '阻断', pass: '通过', revise: '需修订' }[value] ?? value;
}
function categoryLabel(value: string) {
  return (
    {
      brand: '品牌',
      compliance: '合规',
      duplicate: '重复',
      fact: '事实',
      format: '格式',
      readability: '可读性',
      security: '安全',
    }[value] ?? value
  );
}
function decisionClass(value: string) {
  return `rounded-full px-3 py-1 text-xs font-semibold ${value === 'pass' ? 'bg-emerald-50 text-emerald-700' : value === 'block' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800'}`;
}
function severityClass(value: string) {
  return `rounded-full px-2 py-1 text-xs font-semibold ${value === 'BLOCK' ? 'bg-red-50 text-red-700' : value === 'WARN' ? 'bg-amber-50 text-amber-800' : 'bg-ink-100 text-ink-600'}`;
}
function severityLabel(value: string) {
  return { BLOCK: '必须修改', INFO: '提示', WARN: '建议修改' }[value] ?? '提示';
}

const GEO_SCORE_LABELS = [
  ['total', 'GEO 总分'],
  ['answerability', '可回答性'],
  ['question', '问题覆盖'],
  ['entity', '实体清晰度'],
  ['evidence', '证据质量'],
  ['platform_fit', '平台适配'],
  ['readability_safety', '可读性与安全'],
] as const;
const primaryButton =
  'inline-flex h-11 items-center justify-center rounded-control bg-brand-600 px-4 text-sm font-semibold text-white disabled:opacity-50';
const secondaryButton =
  'inline-flex h-11 items-center justify-center rounded-control border border-line px-4 text-sm font-semibold text-ink-700 disabled:opacity-50';
