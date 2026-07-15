'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
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
      setMessage(action === 'approve' ? '变体已通过。' : '变体已退回。');
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
      setMessage('加签要求已创建。');
    } catch (error) {
      setMessage(conflictMessage(error));
    } finally {
      setBusy(null);
    }
  }

  if (state === 'loading')
    return <StatePanel title="正在加载审核快照" text="正在读取冻结内容、规则、Prompt 和引用。" />;
  if (state === 'permission')
    return <StatePanel title="无权查看审核快照" text="仅租户管理员、所有者和审核员可访问。" />;
  if (state === 'error' || !detail)
    return <StatePanel title="无法加载审核快照" text="请确认 URL 中包含有效且可访问的快照 ID。" />;
  return (
    <section className="mt-8 space-y-6">
      <section className="rounded-2xl border border-line bg-white p-5 shadow-panel sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <Status value={detail.snapshot.status} />
            <h2 className="mt-3 font-mono text-sm text-ink-700">快照 {detail.snapshot.id}</h2>
            <p className="mt-2 text-sm text-ink-500">
              版本 {detail.snapshot.version} · 模型 {detail.snapshot.model_key}
            </p>
          </div>
          <Link className={secondaryButton} href="/rev-01">
            返回审核队列
          </Link>
        </div>
        <Hash label="snapshot hash" value={detail.snapshot.snapshot_hash} />
        {message ? (
          <p aria-live="polite" className="mt-4 rounded-xl bg-brand-50 p-3 text-sm text-brand-800">
            {message}
          </p>
        ) : null}
      </section>
      <Panel title="冻结上下文">
        <div className="grid gap-4 md:grid-cols-2">
          <Frozen
            label="品牌策略"
            lines={[
              `ID ${detail.brand_profile.id}`,
              `版本 ${detail.brand_profile.version}`,
              `Schema ${detail.brand_profile.schema_version}`,
            ]}
            json={detail.brand_profile.profile_json}
          />
          <Frozen
            label="Prompt"
            lines={[
              `${detail.prompt_version.skill_name} ${detail.prompt_version.version}`,
              `ID ${detail.prompt_version.id}`,
              `Schema ${detail.prompt_version.schema_version}`,
            ]}
            hash={detail.prompt_version.content_hash}
          />
          <Frozen
            label="规则集合"
            lines={[
              `平台规则 ${detail.snapshot.platform_rules_hash}`,
              `质量规则 ${detail.snapshot.quality_rules_hash}`,
            ]}
          />
          <Frozen
            label="提交信息"
            lines={[
              `提交人 ${detail.snapshot.created_by}`,
              new Date(detail.snapshot.created_at).toLocaleString('zh-CN'),
            ]}
          />
        </div>
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
      <Panel title={`动作时间线（${detail.actions.length}）`}>
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
          <p className="text-sm text-ink-500">尚无审核动作。</p>
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
          <div className="grid gap-3 sm:grid-cols-2">
            <Frozen
              label="冻结内容版本"
              lines={[variant.content_version_id, `Schema ${frozen?.schema_version ?? '—'}`]}
              hash={variant.content_hash}
            />
            <Frozen
              label="平台规则"
              lines={[
                `ID ${variant.platform_rule_version_id}`,
                `版本 ${frozen?.platform_rule.version ?? '—'}`,
              ]}
              hash={frozen?.platform_rule.content_hash}
            />
            <Frozen
              label="质量报告"
              lines={[
                `ID ${variant.quality_report_id}`,
                `得分 ${frozen?.quality_report.score ?? '—'} / decision ${frozen?.quality_report.decision ?? '—'}`,
              ]}
            />
          </div>
          <h3 className="mt-5 text-sm font-semibold text-ink-950">冻结内容</h3>
          <pre className="mt-2 max-h-80 overflow-auto rounded-xl bg-slate-950 p-4 text-xs leading-5 whitespace-pre-wrap text-slate-100">
            {JSON.stringify(frozen?.content_json ?? {}, null, 2)}
          </pre>
          <h3 className="mt-5 text-sm font-semibold text-ink-950">
            引用证据（{frozen?.citations.length ?? 0}）
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
                <Hash label="quote hash" value={c.quote_hash} />
              </article>
            )) ?? null}
          </div>
        </div>
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
            加签角色
            <select
              className={controlClass}
              onChange={(event) => setRequiredRole(event.target.value)}
              value={requiredRole}
            >
              <option value="reviewer">审核人</option>
              <option value="tenant_admin">租户管理员</option>
              <option value="tenant_owner">租户所有者</option>
            </select>
          </label>
          <div className="grid gap-2">
            <button
              className={primaryButton}
              disabled={busy || variant.status !== 'in_review'}
              onClick={() => void onDecision(variant, 'approve', normalizedComment)}
              type="button"
            >
              逐变体通过
            </button>
            <button
              className={dangerButton}
              disabled={busy || variant.status !== 'in_review' || normalizedComment === null}
              onClick={() => void onDecision(variant, 'reject', normalizedComment)}
              type="button"
            >
              退回（意见必填）
            </button>
            <button
              className={secondaryButton}
              disabled={busy || variant.status !== 'in_review'}
              onClick={() => void onSignoff(variant, requiredRole, normalizedComment)}
              type="button"
            >
              请求加签
            </button>
          </div>
          <p className="text-xs leading-5 text-ink-500">
            所有动作携带快照 version；服务端重算冻结 hash，漂移时返回 409，页面不会乐观标记成功。
          </p>
        </div>
      </div>
    </Panel>
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
function Frozen({
  hash,
  json,
  label,
  lines = [],
}: {
  readonly hash?: string | undefined;
  readonly json?: Readonly<Record<string, unknown>>;
  readonly label: string;
  readonly lines?: readonly string[];
}) {
  return (
    <article className="rounded-xl border border-line p-4">
      <h3 className="text-sm font-semibold text-ink-950">{label}</h3>
      {lines.map((line) => (
        <p className="mt-2 break-all font-mono text-xs text-ink-600" key={line}>
          {line}
        </p>
      ))}
      {hash ? <Hash label="content hash" value={hash} /> : null}
      {json ? (
        <pre className="mt-3 max-h-40 overflow-auto rounded-lg bg-surface-subtle p-3 text-xs whitespace-pre-wrap">
          {JSON.stringify(json, null, 2)}
        </pre>
      ) : null}
    </article>
  );
}
function Hash({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <p className="mt-3 break-all font-mono text-xs text-ink-500">
      {label}: {value}
    </p>
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
    ? '动作已被服务端拒绝：冻结 hash 或版本不匹配，请刷新后复核。'
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
