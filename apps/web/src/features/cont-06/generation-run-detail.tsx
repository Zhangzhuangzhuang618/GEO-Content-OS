'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import { getVariantDetail, regenerateVariant } from '../cont-05/content-editor-api';
import type { ModelPolicy } from '../cont-05/content-editor.schema';
import {
  cancelGenerationRun,
  GenerationRunRequestError,
  loadGenerationRunPage,
  type GenerationRunPageData,
} from './generation-run-api';

const RUN_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'content_editor']);
const COST_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin']);
const ACTIVE_STATUSES = new Set(['queued', 'running']);

export function GenerationRunDetail() {
  const [data, setData] = useState<GenerationRunPageData | null>(null);
  const [role, setRole] = useState<TenantRole | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'permission'>('loading');
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('用户取消生成');
  const [modelPolicy, setModelPolicy] = useState<ModelPolicy>('balanced');
  const [message, setMessage] = useState<string | null>(null);
  const [restored, setRestored] = useState<string | null>(null);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('id');
    if (!id || !z.string().uuid().safeParse(id).success) {
      setState('error');
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const tenants = await listAvailableTenants(controller.signal);
        const activeRole = tenants.find((tenant) => tenant.is_active)?.role_code ?? null;
        if (!activeRole || !RUN_ROLES.has(activeRole)) {
          setState('permission');
          return;
        }
        setRole(activeRole);
        setData(await loadGenerationRunPage(id, COST_ROLES.has(activeRole), controller.signal));
        setState('ready');
      } catch (error) {
        if (controller.signal.aborted) return;
        setState(isAccessError(error) ? 'permission' : 'error');
      }
    })();
    return () => controller.abort();
  }, []);

  async function reload() {
    if (!data || !role) return;
    setData(await loadGenerationRunPage(data.run.id, COST_ROLES.has(role)));
  }

  async function cancel() {
    if (!data || !reason.trim()) return;
    await mutate(async (csrf) => {
      await cancelGenerationRun(data.run, reason.trim(), csrf);
      const refreshed = await loadGenerationRunPage(
        data.run.id,
        Boolean(role && COST_ROLES.has(role)),
      );
      setData(refreshed);
      setRestored(restoredStatusText(refreshed));
    }, '运行已取消。');
  }

  async function retry(variantId: string) {
    await mutate(async (csrf) => {
      const detail = await getVariantDetail(variantId);
      await regenerateVariant(detail, modelPolicy, csrf);
      await reload();
    }, '失败变体的重试运行已创建。');
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
    } catch (error) {
      setMessage(
        error instanceof GenerationRunRequestError && error.status === 409
          ? '版本冲突，请刷新后重试。'
          : '操作失败，请检查运行状态后重试。',
      );
    } finally {
      setBusy(false);
    }
  }

  if (state === 'loading')
    return <StatePanel title="正在加载生成运行" text="正在读取状态、内容和结算数据。" />;
  if (state === 'permission')
    return <StatePanel title="无权查看生成运行" text="需要内容编辑或租户管理员权限。" />;
  if (state === 'error' || !data)
    return <StatePanel title="无法加载生成运行" text="请确认 URL 中包含有效且可访问的运行 ID。" />;

  const { run, packageDetail, costs } = data;
  const citations = packageDetail
    ? packageDetail.variants
        .filter((item) => !run.variant_id || item.variant.id === run.variant_id)
        .flatMap((item) => item.citations)
    : [];
  const failedVariants = packageDetail?.variants.filter(
    (item) => item.variant.is_required && item.variant.status === 'generation_failed',
  );
  const progress = statusProgress(run.status);

  return (
    <section className="mt-8 space-y-6">
      <section className="rounded-2xl border border-line bg-white p-5 shadow-panel sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold text-ink-950">{run.skill_name}</h2>
              <span className="rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
                {runStatusLabel(run.status)}
              </span>
            </div>
            <p className="mt-2 font-mono text-xs text-ink-500">{run.id}</p>
          </div>
          {run.package_id ? (
            <Link className={secondaryButton} href={`/cont-04?id=${run.package_id}`}>
              返回内容包
            </Link>
          ) : null}
        </div>
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="阶段" value={`${run.skill_name} · ${runStatusLabel(run.status)}`} />
          <Metric label="模型" value={run.model_key} />
          <Metric label="Skill 版本" value={run.skill_version} />
          <Metric label="Prompt 版本" value={shortId(run.prompt_version_id)} />
        </div>
        <div className="mt-6">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-ink-700">状态进度（非 Token 流）</span>
            <span className="text-ink-500">{progress}%</span>
          </div>
          <div aria-label={`状态进度 ${progress}%`} className="mt-2 h-2 rounded-full bg-ink-100">
            <div className="h-2 rounded-full bg-brand-600" style={{ width: `${progress}%` }} />
          </div>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="已结算成本" subtitle="仅展示成本台账中的 settled 数据。">
          {!COST_ROLES.has(role ?? 'viewer') ? (
            <Empty text="当前角色无成本权限。" />
          ) : costs && costs.totals.length > 0 ? (
            <div className="space-y-3">
              {costs.totals.map((total) => (
                <div
                  className="flex items-center justify-between rounded-xl bg-ink-50 p-4"
                  key={total.currency}
                >
                  <span className="text-sm text-ink-600">{total.entry_count} 条已结算记录</span>
                  <strong className="text-ink-950">
                    {formatMoney(total.cost_cents, total.currency)}
                  </strong>
                </div>
              ))}
              <p className="text-xs text-ink-500">成本明细 {costs.breakdown.length} 项</p>
            </div>
          ) : (
            <Empty text="暂无已结算成本。" />
          )}
        </Panel>

        <Panel title="生命周期日志" subtitle="由运行时间戳生成，不冒充模型提供方日志。">
          <ol className="space-y-3">
            <Log label="已创建" time={run.created_at} />
            <Log label="开始运行" time={run.started_at} />
            <Log label="最后更新" time={run.updated_at} />
            <Log label="运行结束" time={run.finished_at} />
          </ol>
        </Panel>
      </div>

      <Panel title="引用" subtitle="仅显示本运行关联变体当前版本的持久化引用。">
        {citations.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2">
            {citations.map((citation) => (
              <article className="rounded-xl border border-line p-4" key={citation.id}>
                <p className="text-sm font-semibold text-ink-950">{citation.claim_text}</p>
                <blockquote className="mt-2 text-sm leading-6 text-ink-600">
                  {citation.quote_text}
                </blockquote>
                <p className="mt-2 font-mono text-xs text-ink-400">
                  chunk {shortId(citation.chunk_id)}
                </p>
              </article>
            ))}
          </div>
        ) : (
          <Empty text="当前关联内容没有引用。" />
        )}
      </Panel>

      <Panel title="错误" subtitle="保留服务端结构化错误，不推断未返回的信息。">
        {run.error ? (
          <pre className="overflow-x-auto rounded-xl bg-ink-950 p-4 text-xs leading-6 text-white">
            {JSON.stringify(run.error, null, 2)}
          </pre>
        ) : (
          <Empty text="运行未记录错误。" />
        )}
      </Panel>

      <Panel title="运行操作" subtitle="取消后由服务端恢复生成前的稳定内容状态。">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="text-sm font-medium text-ink-700">
            取消原因
            <input
              className={controlClass}
              onChange={(event) => setReason(event.target.value)}
              value={reason}
            />
          </label>
          <label className="text-sm font-medium text-ink-700">
            重试模型策略
            <select
              className={controlClass}
              onChange={(event) => setModelPolicy(event.target.value as ModelPolicy)}
              value={modelPolicy}
            >
              <option value="fast">快速</option>
              <option value="balanced">均衡</option>
              <option value="quality">质量</option>
            </select>
          </label>
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            className={primaryButton}
            disabled={busy || !ACTIVE_STATUSES.has(run.status) || !reason.trim()}
            onClick={() => void cancel()}
            type="button"
          >
            取消运行
          </button>
          {failedVariants?.map((item) => (
            <button
              className={secondaryButton}
              disabled={busy}
              key={item.variant.id}
              onClick={() => void retry(item.variant.id)}
              type="button"
            >
              重试{platformLabel(item.variant.platform_code)}失败变体
            </button>
          ))}
        </div>
        {restored ? <p className="mt-4 text-sm font-medium text-emerald-700">{restored}</p> : null}
        {message ? (
          <p aria-live="polite" className="mt-4 text-sm text-ink-600">
            {message}
          </p>
        ) : null}
        {!ACTIVE_STATUSES.has(run.status) && !failedVariants?.length ? (
          <p className="mt-4 text-sm text-ink-500">当前运行已结束，且没有可重试的生成失败变体。</p>
        ) : null}
      </Panel>
    </section>
  );
}

function restoredStatusText(data: GenerationRunPageData) {
  const variants = data.packageDetail?.variants.filter((item) => item.variant.is_required) ?? [];
  if (variants.length === 0) return '运行已取消；没有关联变体需要恢复。';
  return `取消后变体已恢复：${variants
    .map(
      (item) =>
        `${platformLabel(item.variant.platform_code)} ${variantStatusLabel(item.variant.status)}`,
    )
    .join('、')}`;
}
function statusProgress(status: string) {
  if (status === 'queued') return 10;
  if (status === 'running') return 50;
  return 100;
}
function runStatusLabel(status: string) {
  return (
    { cancelled: '已取消', failed: '失败', queued: '排队中', running: '运行中', succeeded: '成功' }[
      status
    ] ?? status
  );
}
function variantStatusLabel(status: string) {
  return (
    {
      generated: '已生成',
      generation_failed: '生成失败',
      quality_failed: '质量未通过',
      quality_passed: '质量通过',
    }[status] ?? status
  );
}
function platformLabel(code: string) {
  return (
    {
      baijiahao: '百家号',
      douyin: '抖音',
      official_site: '官网',
      toutiao: '头条号',
      wechat_mp: '微信公众号',
      xiaohongshu: '小红书',
      zhihu: '知乎',
    }[code] ?? code
  );
}
function formatMoney(cents: number, currency: string) {
  return `${currency} ${(cents / 100).toFixed(2)}`;
}
function formatTime(value: string | null) {
  return value
    ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      )
    : '未发生';
}
function readCookie(name: string) {
  const entry = document.cookie.split('; ').find((value) => value.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
}
function shortId(id: string) {
  return id.slice(0, 8);
}
function isAccessError(error: unknown) {
  return error instanceof GenerationRunRequestError && [401, 403, 404].includes(error.status);
}
function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-xl bg-ink-50 p-4">
      <p className="text-xs text-ink-500">{label}</p>
      <p className="mt-2 break-words text-sm font-semibold text-ink-950">{value}</p>
    </div>
  );
}
function Log({ label, time }: { readonly label: string; readonly time: string | null }) {
  return (
    <li className="flex items-center justify-between gap-4 border-b border-line pb-3 text-sm last:border-0 last:pb-0">
      <span className="font-medium text-ink-700">{label}</span>
      <time className="text-right text-ink-500">{formatTime(time)}</time>
    </li>
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

const controlClass =
  'mt-2 h-11 w-full rounded-control border border-line bg-white px-3 text-sm text-ink-950 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-100';
const primaryButton =
  'inline-flex h-11 items-center justify-center rounded-control bg-brand-600 px-4 text-sm font-semibold text-white disabled:opacity-50';
const secondaryButton =
  'inline-flex h-11 items-center justify-center rounded-control border border-line px-4 text-sm font-semibold text-ink-700 disabled:opacity-50';
