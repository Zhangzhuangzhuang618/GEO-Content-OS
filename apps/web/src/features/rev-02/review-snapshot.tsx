'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import { modelLabel, skillLabel, TechnicalDetails } from '../human-readable';
import {
  decideReview,
  getReviewSnapshot,
  requestReviewSignoff,
  ReviewSnapshotRequestError,
} from './review-snapshot-api';
import type { ReviewSnapshotDetail, SnapshotVariant } from './review-snapshot.schema';

const REVIEW_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'reviewer']);

export function ReviewSnapshot() {
  const [detail, setDetail] = useState<ReviewSnapshotDetail | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'permission'>('loading');
  const [busy, setBusy] = useState<string | null>(null);
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
          getReviewSnapshot(id, controller.signal),
        ]);
        const role = tenants.find((t) => t.is_active)?.role_code;
        if (!role || !REVIEW_ROLES.has(role)) {
          setState('permission');
          return;
        }
        setDetail(loaded);
        setState('ready');
      } catch (error) {
        if (controller.signal.aborted) return;
        setState(isAccessError(error) ? 'permission' : 'error');
      }
    })();
    return () => controller.abort();
  }, []);

  async function decide(
    variant: SnapshotVariant,
    action: 'approve' | 'reject',
    comment: string | null,
  ) {
    if (!detail) return;
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    setBusy(variant.variant_id);
    setMessage(null);
    try {
      const loaded = await decideReview({
        action,
        comment,
        csrf,
        snapshotId: detail.snapshot.id,
        variantId: variant.variant_id,
        version: detail.snapshot.version,
      });
      setDetail(loaded);
      setMessage(action === 'approve' ? '该平台内容已通过。' : '该平台内容已退回修改。');
    } catch (error) {
      setMessage(conflictMessage(error));
    } finally {
      setBusy(null);
    }
  }
  async function signoff(variant: SnapshotVariant, role: string, comment: string | null) {
    if (!detail) return;
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    setBusy(variant.variant_id);
    setMessage(null);
    try {
      await requestReviewSignoff({
        comment,
        csrf,
        requiredRole: role,
        snapshotId: detail.snapshot.id,
        variantId: variant.variant_id,
        version: detail.snapshot.version,
      });
      const loaded = await getReviewSnapshot(detail.snapshot.id);
      setDetail(loaded);
      setMessage('已邀请另一位负责人共同确认。');
    } catch (error) {
      setMessage(conflictMessage(error));
    } finally {
      setBusy(null);
    }
  }

  if (state === 'loading')
    return <StatePanel title="正在加载审核内容" text="正在读取待审核内容和事实依据。" />;
  if (state === 'permission')
    return <StatePanel title="无权查看审核内容" text="仅管理员、所有者和审核员可访问。" />;
  if (state === 'error' || !detail)
    return (
      <StatePanel
        title="无法加载审核内容"
        text="这条审核任务可能已失效、被删除或不在你的权限范围内。"
      />
    );
  return (
    <section className="mt-8 space-y-6">
      <section className="rounded-2xl border border-line bg-white p-5 shadow-panel sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <Status value={detail.snapshot.status} />
            <h2 className="mt-3 text-xl font-semibold text-ink-950">内容审核</h2>
            <p className="mt-2 text-sm text-ink-500">
              提交于 {new Date(detail.snapshot.created_at).toLocaleString('zh-CN')} ·{' '}
              {detail.snapshot.variants.length} 个平台
            </p>
          </div>
          <Link className={secondaryButton} href="/rev-01">
            返回审核队列
          </Link>
        </div>
        <TechnicalDetails summary="审核记录技术信息">
          <p>审核记录：{detail.snapshot.id}</p>
          <p>记录版本：{detail.snapshot.version}</p>
          <p>生成方式：{modelLabel(detail.snapshot.model_key)}</p>
          <p>内容校验值：{detail.snapshot.snapshot_hash}</p>
        </TechnicalDetails>
        {message ? (
          <p aria-live="polite" className="mt-4 rounded-xl bg-brand-50 p-3 text-sm text-brand-800">
            {message}
          </p>
        ) : null}
      </section>
      <Panel title="审核说明">
        <p className="text-sm leading-6 text-ink-600">
          请按平台逐项确认内容是否准确、合规并符合发布要求。系统已锁定本次提交版本，审核期间的后续编辑不会混入当前内容。
        </p>
        <TechnicalDetails summary="生成规则与版本信息">
          <p>
            品牌策略：第 {detail.brand_profile.version} 版（{detail.brand_profile.id}）
          </p>
          <p>
            内容处理：{skillLabel(detail.prompt_version.skill_name)} {detail.prompt_version.version}
          </p>
          <p>处理规则：{detail.prompt_version.id}</p>
          <p>平台规则校验值：{detail.snapshot.platform_rules_hash}</p>
          <p>质量规则校验值：{detail.snapshot.quality_rules_hash}</p>
        </TechnicalDetails>
      </Panel>
      {detail.snapshot.variants.map((variant) => {
        const frozen = detail.variants.find((v) => v.snapshot_variant_id === variant.id);
        return (
          <VariantCard
            busy={busy === variant.variant_id}
            frozen={frozen}
            key={variant.id}
            onDecision={decide}
            onSignoff={signoff}
            variant={variant}
          />
        );
      })}
      <Panel title={`审核记录（${detail.actions.length}）`}>
        {detail.actions.length ? (
          <ol className="space-y-3">
            {detail.actions.map((action) => (
              <li className="rounded-xl border border-line p-4 text-sm" key={action.id}>
                <strong>{actionLabel(action.action)}</strong>
                <span className="ml-2 text-ink-500">
                  {new Date(action.created_at).toLocaleString('zh-CN')}
                </span>
                {action.comment ? <p className="mt-2 text-ink-700">{action.comment}</p> : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-ink-500">尚无审核记录。</p>
        )}
      </Panel>
    </section>
  );
}

function VariantCard({
  busy,
  frozen,
  onDecision,
  onSignoff,
  variant,
}: {
  readonly busy: boolean;
  readonly frozen: ReviewSnapshotDetail['variants'][number] | undefined;
  readonly onDecision: (
    variant: SnapshotVariant,
    action: 'approve' | 'reject',
    comment: string | null,
  ) => Promise<void>;
  readonly onSignoff: (
    variant: SnapshotVariant,
    role: string,
    comment: string | null,
  ) => Promise<void>;
  readonly variant: SnapshotVariant;
}) {
  const [comment, setComment] = useState('');
  const [requiredRole, setRequiredRole] = useState('reviewer');
  const normalizedComment = comment.trim() || null;
  return (
    <Panel title={`${platformLabel(variant.platform_code)} · ${statusLabel(variant.status)}`}>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div>
          <div className="rounded-xl bg-surface-subtle p-4 text-sm text-ink-700">
            质量得分：
            <strong className="text-ink-950">{frozen?.quality_report.score ?? '—'} 分</strong>
          </div>
          <ContentPreview value={frozen?.content_json} />
          <h3 className="mt-5 text-sm font-semibold text-ink-950">
            事实依据（{frozen?.citations.length ?? 0}）
          </h3>
          <div className="mt-2 space-y-3">
            {frozen?.citations.map((c) => (
              <article
                className="rounded-xl border border-line p-4"
                key={`${c.claim_key}-${c.ai_citation_id}`}
              >
                <strong className="text-sm">{c.claim_text}</strong>
                <blockquote className="mt-2 border-l-2 border-brand-200 pl-3 text-sm text-ink-600">
                  {c.quote_text}
                </blockquote>
              </article>
            )) ?? null}
          </div>
          <TechnicalDetails summary="本平台内容技术信息">
            <p>内容版本：{variant.content_version_id}</p>
            <p>内容校验值：{variant.content_hash}</p>
            <p>平台规则：{variant.platform_rule_version_id}</p>
            <p>规则版本：{frozen?.platform_rule.version ?? '—'}</p>
            <p>质量报告：{variant.quality_report_id}</p>
            <p>数据格式：{frozen?.schema_version ?? '—'}</p>
          </TechnicalDetails>
        </div>
        {variant.status === 'in_review' ? (
          <div className="space-y-3 rounded-xl bg-surface-subtle p-4">
            <label className="block text-sm text-ink-700">
              意见
              <textarea
                className={`${controlClass} min-h-24 py-3`}
                onChange={(event) => setComment(event.target.value)}
                value={comment}
              />
            </label>
            <label className="block text-sm text-ink-700">
              需要谁共同确认
              <select
                className={controlClass}
                onChange={(event) => setRequiredRole(event.target.value)}
                value={requiredRole}
              >
                <option value="reviewer">其他审核人</option>
                <option value="tenant_admin">企业管理员</option>
                <option value="tenant_owner">企业所有者</option>
              </select>
            </label>
            <div className="grid gap-2">
              <button
                className={primaryButton}
                disabled={busy}
                onClick={() => void onDecision(variant, 'approve', normalizedComment)}
                type="button"
              >
                {busy ? '正在保存审核结果…' : '通过此平台内容'}
              </button>
              <button
                className={dangerButton}
                disabled={busy || normalizedComment === null}
                onClick={() => void onDecision(variant, 'reject', normalizedComment)}
                type="button"
              >
                退回修改（请填写原因）
              </button>
              <button
                className={secondaryButton}
                disabled={busy}
                onClick={() => void onSignoff(variant, requiredRole, normalizedComment)}
                type="button"
              >
                邀请他人共同确认
              </button>
            </div>
            <p className="text-xs leading-5 text-ink-500">
              提交决定前，系统会再次确认你看到的内容没有被替换。
            </p>
          </div>
        ) : (
          <DecisionResult status={variant.status} variantId={variant.variant_id} />
        )}
      </div>
    </Panel>
  );
}

function DecisionResult({
  status,
  variantId,
}: {
  readonly status: 'approved' | 'rejected';
  readonly variantId: string;
}) {
  const approved = status === 'approved';
  return (
    <div
      aria-live="polite"
      className={`rounded-xl border p-5 ${approved ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'}`}
      role="status"
    >
      <h3 className={`font-semibold ${approved ? 'text-emerald-900' : 'text-amber-900'}`}>
        {approved ? '此平台内容已通过' : '此平台内容已退回修改'}
      </h3>
      <p className={`mt-2 text-sm leading-6 ${approved ? 'text-emerald-800' : 'text-amber-800'}`}>
        {approved
          ? '审核结果已经保存，这份内容可以进入发布准备。'
          : '审核结果已经保存，内容负责人可以根据退回原因进行修改。'}
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        {approved ? (
          <Link className={primaryButton} href={`/pub-02?variant_id=${variantId}`}>
            安排发布
          </Link>
        ) : null}
        <Link className={`${secondaryButton} bg-white`} href="/rev-01">
          返回待审核内容
        </Link>
      </div>
    </div>
  );
}
function Panel({
  children,
  title,
}: {
  readonly children: React.ReactNode;
  readonly title: string;
}) {
  return (
    <section className="rounded-2xl border border-line bg-white p-5 shadow-panel sm:p-6">
      <h2 className="text-lg font-semibold text-ink-950">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}
function ContentPreview({
  value,
}: {
  readonly value: Readonly<Record<string, unknown>> | undefined;
}) {
  const title = typeof value?.title === 'string' ? value.title : '';
  const summary = typeof value?.summary === 'string' ? value.summary : '';
  const blocks = Array.isArray(value?.blocks) ? value.blocks : [];
  return (
    <article className="mt-5 rounded-xl border border-line p-4">
      <h3 className="text-lg font-semibold text-ink-950">{title || '待审核内容'}</h3>
      {summary ? <p className="mt-3 leading-7 text-ink-600">{summary}</p> : null}
      <div className="mt-4 space-y-4">
        {blocks.map((block, index) => {
          const record =
            typeof block === 'object' && block ? (block as Record<string, unknown>) : {};
          const text = typeof record.text === 'string' ? record.text : '';
          const heading = typeof record.heading === 'string' ? record.heading : '';
          if (!text && !heading) return null;
          return (
            <section className="leading-7 text-ink-700" key={index}>
              {heading ? <h4 className="font-semibold text-ink-950">{heading}</h4> : null}
              {text ? <p className={heading ? 'mt-2' : ''}>{text}</p> : null}
            </section>
          );
        })}
      </div>
    </article>
  );
}
function Status({ value }: { readonly value: string }) {
  return (
    <span className="inline-flex rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
      {statusLabel(value)}
    </span>
  );
}
function StatePanel({ title, text }: { readonly title: string; readonly text: string }) {
  return (
    <div className="mt-6 rounded-2xl border border-line bg-white p-8 text-center shadow-panel">
      <h2 className="font-semibold text-ink-950">{title}</h2>
      <p className="mt-2 text-sm text-ink-500">{text}</p>
    </div>
  );
}
function conflictMessage(error: unknown) {
  return error instanceof ReviewSnapshotRequestError && error.status === 409
    ? '内容已发生变化，请刷新页面并重新确认后再提交。'
    : '操作失败，请检查状态、权限或输入后重试。';
}
function isAccessError(error: unknown) {
  return error instanceof ReviewSnapshotRequestError && [401, 403, 404].includes(error.status);
}
function readCookie(name: string) {
  const entry = document.cookie.split('; ').find((value) => value.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
}
function actionLabel(value: string) {
  return (
    { approve: '通过', reject: '退回', request_signoff: '请求加签', comment: '评论' }[value] ??
    value
  );
}
function statusLabel(value: string) {
  return (
    { in_review: '审核中', approved: '已通过', rejected: '已退回', superseded: '已替代' }[value] ??
    value
  );
}
function platformLabel(value: string) {
  return (
    {
      official_site: '官网',
      baijiahao: '百家号',
      toutiao: '头条号',
      zhihu: '知乎',
      xiaohongshu: '小红书',
      wechat_mp: '微信公众号',
      douyin: '抖音',
    }[value] ?? value
  );
}
const controlClass =
  'mt-2 w-full rounded-control border border-line bg-white px-3 text-sm text-ink-950 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-100';
const primaryButton =
  'h-11 rounded-control bg-brand-600 px-4 text-sm font-semibold text-white disabled:opacity-50';
const secondaryButton =
  'inline-flex h-11 items-center justify-center rounded-control border border-line px-4 text-sm font-semibold text-ink-700 disabled:opacity-50';
const dangerButton =
  'h-11 rounded-control bg-red-700 px-4 text-sm font-semibold text-white disabled:opacity-50';
