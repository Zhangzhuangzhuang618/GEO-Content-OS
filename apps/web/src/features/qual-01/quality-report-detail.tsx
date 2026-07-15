'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import {
  getQualityVariantDetail,
  QualityReportRequestError,
  requestQualityCheck,
  submitQualityPassedVariant,
} from './quality-report-api';
import type { QualityIssue, QualityVariantDetail } from './quality-report.schema';

const WRITE_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'content_editor']);
const RECHECK_STATUSES = new Set(['generated', 'quality_failed', 'quality_passed']);

export function QualityReportDetail() {
  const [detail, setDetail] = useState<QualityVariantDetail | null>(null);
  const [role, setRole] = useState<TenantRole | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'permission'>('loading');
  const [busy, setBusy] = useState(false);
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

  async function recheck() {
    if (!detail) return;
    await mutate(
      (csrf) => requestQualityCheck(detail.variant.id, csrf),
      '完整质量检查运行已创建。',
    );
  }

  async function submitReview() {
    if (!detail) return;
    await mutate(
      (csrf) => submitQualityPassedVariant(detail.variant.package_id, detail.variant.id, csrf),
      '质量通过变体已提交审核。',
    );
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
      setMessage('裁决请求摘要已复制；当前冻结 API 未提供提交端点，请交由既有人工流程接收。');
    } catch {
      setMessage('无法复制裁决请求摘要，请检查浏览器剪贴板权限。');
    }
  }

  async function mutate(work: (csrf: string) => Promise<void>, success: string) {
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await work(csrf);
      setMessage(success);
    } catch {
      setMessage('操作失败，请检查当前状态或稍后重试。');
    } finally {
      setBusy(false);
    }
  }

  if (state === 'loading')
    return <StatePanel title="正在加载质量报告" text="正在读取报告、问题和引用证据。" />;
  if (state === 'permission')
    return <StatePanel title="无权查看质量报告" text="需要当前租户的有效成员身份。" />;
  if (state === 'error' || !detail)
    return <StatePanel title="无法加载质量报告" text="请确认 URL 中包含有效且可访问的变体 ID。" />;
  if (!detail.quality_report)
    return (
      <StatePanel
        title="暂无质量报告"
        text="当前变体尚未完成质量检查；有写权限的成员可从内容编辑器发起检查。"
      />
    );

  const report = detail.quality_report;
  const canWrite = Boolean(role && WRITE_ROLES.has(role));
  const canRecheck = canWrite && RECHECK_STATUSES.has(detail.variant.status);
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
              <span className="text-sm text-ink-500">checker {report.checker_version}</span>
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
            当前 decision 为 {report.decision}，质量门禁禁止提交审核。
          </p>
        ) : null}
        {message ? (
          <p aria-live="polite" className="mt-4 text-sm text-ink-600">
            {message}
          </p>
        ) : null}
      </section>

      <Panel title="GEO 子分" subtitle="各项均为 0–100 分，来自当前不可变质量报告。">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {GEO_SCORE_LABELS.map(([key, label]) => (
            <Score key={key} label={label} value={report.geo_scores[key]} />
          ))}
        </div>
      </Panel>

      <Panel
        title={`问题（${report.issues.length}）`}
        subtitle="BLOCK 为硬阻断，WARN 需修订，INFO 仅提示。"
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

      <Panel title="Claim 与证据" subtitle="仅展示已持久化 ai_citations；不补造缺失证据。">
        {detail.citations.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2">
            {detail.citations.map((citation) => (
              <article
                className="rounded-xl border border-line p-4"
                id={`citation-${citation.id}`}
                key={citation.id}
              >
                <p className="text-xs font-semibold tracking-wide text-brand-700 uppercase">
                  {citation.claim_key}
                </p>
                <h3 className="mt-2 font-semibold text-ink-950">{citation.claim_text}</h3>
                <blockquote className="mt-3 border-l-2 border-brand-200 pl-3 text-sm leading-6 text-ink-600">
                  {citation.quote_text}
                </blockquote>
                <p className="mt-2 font-mono text-xs text-ink-400">
                  chunk {shortId(citation.chunk_id)}
                </p>
              </article>
            ))}
          </div>
        ) : (
          <Empty text="当前内容版本没有持久化引用证据。" />
        )}
      </Panel>

      <Panel title="人工裁决" subtitle="仅针对事实争议生成请求摘要，不改变内容、质量或发布状态。">
        <button
          className={secondaryButton}
          disabled={busy || factIssues.length === 0}
          onClick={() => void copyHumanReviewRequest()}
          type="button"
        >
          请求人工裁决
        </button>
        <p className="mt-3 text-xs leading-5 text-ink-500">
          冻结 API 未定义人工裁决写端点；此动作只复制关联 claim、证据与原因，供既有人工流程接收。
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
        <span className={severityClass(issue.severity)}>{issue.severity}</span>
        <span className="text-xs text-ink-500">
          {categoryLabel(issue.category)} · {issue.rule_id}
        </span>
      </div>
      <p className="mt-3 text-sm font-medium text-ink-950">{issue.message}</p>
      {issue.suggestion ? (
        <p className="mt-2 text-sm text-ink-600">建议：{issue.suggestion}</p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-ink-500">
        <span>位置：{issue.location ?? '全局'}</span>
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
function shortId(id: string) {
  return id.slice(0, 8);
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
