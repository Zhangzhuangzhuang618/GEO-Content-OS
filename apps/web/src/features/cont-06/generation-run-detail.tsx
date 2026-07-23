'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import { getVariantDetail, regenerateVariant } from '../cont-05/content-editor-api';
import type { ModelPolicy } from '../cont-05/content-editor.schema';
import { modelLabel, skillLabel, TechnicalDetails } from '../human-readable';
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
    }, '内容生成已取消。');
  }

  async function retry(variantId: string) {
    await mutate(async (csrf) => {
      const detail = await getVariantDetail(variantId);
      await regenerateVariant(detail, modelPolicy, csrf);
      await reload();
    }, '失败平台的内容已重新开始生成。');
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
    return <StatePanel title="正在加载生成详情" text="正在读取进度、内容和费用。" />;
  if (state === 'permission')
    return <StatePanel title="无权查看生成详情" text="需要内容编辑或企业管理员权限。" />;
  if (state === 'error' || !data)
    return <StatePanel title="无法加载生成详情" text="请从内容详情页重新进入。" />;

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
              <h2 className="text-xl font-semibold text-ink-950">{skillLabel(run.skill_name)}</h2>
              <span className="rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
                {runStatusLabel(run.status)}
              </span>
            </div>
            <p className="mt-2 text-sm text-ink-500">{generationSummary(run.status)}</p>
          </div>
          {run.package_id ? (
            <Link className={secondaryButton} href={`/cont-04?id=${run.package_id}`}>
              返回内容详情
            </Link>
          ) : null}
        </div>
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <Metric label="处理步骤" value={skillLabel(run.skill_name)} />
          <Metric label="生成方式" value={modelLabel(run.model_key)} />
          <Metric label="当前状态" value={runStatusLabel(run.status)} />
        </div>
        <div className="mt-6">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-ink-700">处理进度</span>
            <span className="text-ink-500">{progress}%</span>
          </div>
          <div aria-label={`状态进度 ${progress}%`} className="mt-2 h-2 rounded-full bg-ink-100">
            <div className="h-2 rounded-full bg-brand-600" style={{ width: `${progress}%` }} />
          </div>
        </div>
        <div className="mt-5">
          <TechnicalDetails>
            <p>记录编号：{run.id}</p>
            <p>
              处理程序：{run.skill_name} {run.skill_version}
            </p>
            <p>模型配置：{run.model_key}</p>
            <p>提示词版本：{run.prompt_version_id}</p>
          </TechnicalDetails>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="本次费用" subtitle="这里只统计已经确认的实际费用。">
          {!COST_ROLES.has(role ?? 'viewer') ? (
            <Empty text="当前角色无成本权限。" />
          ) : costs && costs.totals.length > 0 ? (
            <div className="space-y-3">
              {costs.totals.map((total) => (
                <div
                  className="flex items-center justify-between rounded-xl bg-ink-50 p-4"
                  key={total.currency}
                >
                  <span className="text-sm text-ink-600">已确认费用</span>
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

        <Panel title="处理时间" subtitle="展示本次内容生成的关键时间点。">
          <ol className="space-y-3">
            <Log label="已创建" time={run.created_at} />
            <Log label="开始处理" time={run.started_at} />
            <Log label="最后更新" time={run.updated_at} />
            <Log label="处理结束" time={run.finished_at} />
          </ol>
        </Panel>
      </div>

      <Panel title="事实依据" subtitle="展示本次内容引用的原始资料。">
        {citations.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2">
            {citations.map((citation) => (
              <article className="rounded-xl border border-line p-4" key={citation.id}>
                <p className="text-sm font-semibold text-ink-950">{citation.claim_text}</p>
                <blockquote className="mt-2 text-sm leading-6 text-ink-600">
                  {citation.quote_text}
                </blockquote>
              </article>
            ))}
          </div>
        ) : (
          <Empty text="当前内容没有可展示的事实依据。" />
        )}
      </Panel>

      <Panel title="问题说明" subtitle="如果生成失败，这里会告诉你下一步该怎么做。">
        {run.error ? (
          <div className="space-y-4">
            <p className="rounded-xl bg-red-50 p-4 text-sm leading-6 text-red-800">
              {runErrorMessage(run.error)}
            </p>
            <TechnicalDetails summary="错误技术信息">
              <pre className="whitespace-pre-wrap">{JSON.stringify(run.error, null, 2)}</pre>
            </TechnicalDetails>
          </div>
        ) : (
          <Empty text="本次生成没有记录到问题。" />
        )}
      </Panel>

      <Panel title="生成操作" subtitle="可以取消正在进行的生成，或重新尝试失败的平台。">
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
            重新生成偏好
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
            取消生成
          </button>
          {failedVariants?.map((item) => (
            <button
              className={secondaryButton}
              disabled={busy}
              key={item.variant.id}
              onClick={() => void retry(item.variant.id)}
              type="button"
            >
              重新生成{platformLabel(item.variant.platform_code)}内容
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
          <p className="mt-4 text-sm text-ink-500">本次生成已结束，没有需要重新处理的平台。</p>
        ) : null}
      </Panel>
    </section>
  );
}

function restoredStatusText(data: GenerationRunPageData) {
  const variants = data.packageDetail?.variants.filter((item) => item.variant.is_required) ?? [];
  if (variants.length === 0) return '生成已取消；没有关联的平台内容需要恢复。';
  return `取消后平台内容已恢复：${variants
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
function generationSummary(status: string) {
  if (status === 'queued') return '正在等待系统开始处理';
  if (status === 'running') return '系统正在生成内容，请稍候';
  if (status === 'succeeded') return '内容已生成完成';
  if (status === 'failed') return '内容生成遇到问题';
  return '本次生成已取消';
}
function runErrorMessage(error: Readonly<Record<string, unknown>>) {
  const code = typeof error['code'] === 'string' ? error['code'] : '';
  const labels: Readonly<Record<string, string>> = {
    AI_PROVIDER_TIMEOUT: '生成服务响应超时，请稍后重新生成。',
    MODEL_TIMEOUT: '生成服务响应超时，请稍后重新生成。',
    SKILL_OUTPUT_INVALID: '生成结果格式不完整，请重新生成。',
    SCHEMA_VALIDATION_FAILED: '生成结果缺少必要内容，请重新生成。',
  };
  if (labels[code]) return labels[code];
  const message = typeof error['message'] === 'string' ? error['message'] : '';
  return message || '内容生成失败，请重新尝试；如果问题持续出现，请联系管理员。';
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
