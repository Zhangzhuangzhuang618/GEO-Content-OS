'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import { TechnicalDetails } from '../human-readable';
import type { PublishJob } from '../pub-02/publishing-calendar.schema';
import {
  cancelUnexecutedPublishJob,
  generatePublishJobMedia,
  getPublishJobDetail,
  getSignedExport,
  PublishJobDetailRequestError,
  reconcileBaijiahaoPublishJob,
  resolveUnknownPublishJob,
  retryPublishJob,
} from './publish-job-detail-api';
import type {
  ExportArtifact,
  PublishAttempt,
  PublishJobDetail,
  SignedDownload,
} from './publish-job-detail.schema';

const PUBLISH_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'publisher']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
type BusyAction =
  'retry' | 'reschedule' | 'cancel' | 'download' | 'media' | 'reconcile' | 'resolve';

export function PublishJobDetailView() {
  const [jobId] = useState(readJobId);
  const [detail, setDetail] = useState<PublishJobDetail | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error' | 'permission'>(
    'loading',
  );
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [download, setDownload] = useState<SignedDownload | null>(null);

  const load = useCallback(async (nextId: string | null, signal?: AbortSignal) => {
    setState('loading');
    try {
      const tenants = await listAvailableTenants(signal);
      const role = tenants.find((tenant) => tenant.is_active)?.role_code;
      if (!role || !PUBLISH_ROLES.has(role)) {
        setState('permission');
        return;
      }
      if (!nextId) {
        setDetail(null);
        setState('empty');
        return;
      }
      const value = await getPublishJobDetail(nextId, signal);
      if (signal?.aborted) return;
      setDetail(value);
      setState('ready');
    } catch (error) {
      if (signal?.aborted) return;
      setState(isAccessError(error) ? 'permission' : 'error');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setDownload(null);
    setMessage(null);
    void load(jobId, controller.signal);
    return () => controller.abort();
  }, [jobId, load]);

  useEffect(() => {
    if (!jobId || (detail?.media.status !== 'queued' && detail?.media.status !== 'running')) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      void getPublishJobDetail(jobId, controller.signal)
        .then((value) => {
          setDetail(value);
          if (value.media.status === 'ready') setMessage('配图已生成，将随文章一起发布。');
          if (value.media.status === 'none') setMessage('本次配图未生成，可以重新尝试。');
        })
        .catch(() => undefined);
    }, 2_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [detail?.media.status, jobId]);

  async function runAction(action: 'retry' | 'reschedule' | 'cancel') {
    if (!detail) return;
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    let reason = '';
    let scheduledAt: string | null = null;
    if (action === 'cancel') {
      reason = window.prompt('请输入取消原因。')?.trim() ?? '';
      if (!reason) return;
    }
    if (action === 'reschedule') {
      const fallback = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      const existing =
        Date.parse(detail.job.scheduled_at) > Date.now() ? detail.job.scheduled_at : fallback;
      const value = window.prompt('请输入新的排期时间。', toLocalDateTime(existing));
      if (value === null) return;
      scheduledAt = toIso(value);
      if (!scheduledAt) {
        setMessage('重新排期失败：请输入有效时间。');
        return;
      }
    }
    setBusy(action);
    setMessage(null);
    try {
      if (action === 'retry') await retryPublishJob(detail.job, csrf);
      if (action === 'reschedule')
        await retryPublishJob(detail.job, csrf, scheduledAt ?? undefined);
      if (action === 'cancel') await cancelUnexecutedPublishJob(detail.job, reason, csrf);
      setMessage(
        action === 'retry'
          ? '发布重试已排队。'
          : action === 'reschedule'
            ? '发布任务已重新排期。'
            : '未执行任务已取消。',
      );
      await load(detail.job.id);
    } catch {
      setMessage('操作失败；任务版本、状态或外部结果可能已变化，请刷新后重试。');
    } finally {
      setBusy(null);
    }
  }

  async function prepareDownload() {
    if (!detail?.export_artifact) return;
    setBusy('download');
    setDownload(null);
    setMessage(null);
    try {
      const signed = await getSignedExport(detail.job.id);
      if (!safeHttpUrl(signed.url)) throw new Error('Unsafe signed URL');
      setDownload(signed);
      setMessage('导出包下载地址已生成，请在有效期内使用。');
    } catch {
      setMessage('导出包暂不可下载，请确认制品仍在有效期内。');
    } finally {
      setBusy(null);
    }
  }

  async function generateMedia() {
    if (!detail) return;
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    setBusy('media');
    setMessage(null);
    try {
      await generatePublishJobMedia(detail.job, csrf);
      setMessage('配图生成已排队，页面会自动更新结果。');
      setDetail(await getPublishJobDetail(detail.job.id));
    } catch {
      setMessage('配图生成未能启动；任务状态、内容版本或质量报告可能已经变化。');
    } finally {
      setBusy(null);
    }
  }

  async function resolveUnknown(resolution: 'not_published' | 'published') {
    if (!detail?.unknown_resolution) return;
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    let input:
      | { readonly resolution: 'not_published' }
      | {
          readonly external_post_id?: string;
          readonly external_url: string;
          readonly resolution: 'published';
        };
    if (resolution === 'not_published') {
      if (
        !window.confirm(
          '请确认已在百家号内容管理中按标题核对，确实没有创建该文章。确认后系统会立即重新发布。',
        )
      ) {
        return;
      }
      input = { resolution };
    } else {
      const value = window.prompt('请粘贴已经发布的百家号文章公开链接。')?.trim();
      const externalUrl = value ? safeHttpUrl(value) : null;
      if (!externalUrl) {
        setMessage('确认失败：必须提供有效的 HTTP 或 HTTPS 公开链接。');
        return;
      }
      const externalPostId = externalIdFromUrl(externalUrl);
      input = {
        ...(externalPostId ? { external_post_id: externalPostId } : {}),
        external_url: externalUrl,
        resolution,
      };
    }
    setBusy('resolve');
    setMessage(null);
    try {
      await resolveUnknownPublishJob(detail.job, csrf, input);
      setMessage(
        resolution === 'published'
          ? '已按人工核实结果记录为已发布。'
          : '已确认百家号未创建该文章，发布重试已排队。',
      );
      await load(detail.job.id);
    } catch {
      setMessage('处置失败；任务版本、登录态、尝试上限或外部发布记录可能已经变化。');
    } finally {
      setBusy(null);
    }
  }

  async function reconcileBaijiahao() {
    if (!detail?.baijiahao_reconciliation) return;
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    setBusy('reconcile');
    setMessage(null);
    try {
      await reconcileBaijiahaoPublishJob(detail.job, csrf);
      setMessage('百家号发布状态核验已重新排队；不会再次提交文章。');
      await load(detail.job.id);
    } catch {
      setMessage('重新核验失败；任务版本、浏览器终态或登录状态可能已经变化。');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mt-8">
      <div aria-live="polite" className="mt-4 min-h-6 text-sm text-ink-700">
        {message}
        {download ? (
          <>
            {' '}
            <a
              className="font-semibold text-brand-700 underline"
              href={download.url}
              rel="noopener noreferrer"
              target="_blank"
            >
              开始下载
            </a>
            <span className="ml-2 text-xs text-ink-500">
              有效至 {formatDate(download.expires_at)}
            </span>
          </>
        ) : null}
      </div>

      {state === 'loading' ? (
        <StatePanel title="正在加载发布详情" text="正在读取发布进度和结果。" />
      ) : state === 'permission' ? (
        <StatePanel title="无权查看发布任务" text="仅发布人、企业管理员和所有者可访问。" />
      ) : state === 'error' ? (
        <StatePanel title="无法加载发布任务" text="任务不存在、超出授权范围或服务暂不可用。" />
      ) : state === 'empty' || !detail ? (
        <StatePanel
          title="没有选中发布任务"
          text="请从发布日历中点击“查看详情”进入。"
          action={
            <Link className={primaryButton} href="/pub-02">
              返回发布日历
            </Link>
          }
        />
      ) : (
        <DetailContent
          busy={busy}
          detail={detail}
          onAction={runAction}
          onDownload={prepareDownload}
          onGenerateMedia={generateMedia}
          onReconcileBaijiahao={reconcileBaijiahao}
          onResolveUnknown={resolveUnknown}
        />
      )}
    </section>
  );
}

function DetailContent({
  busy,
  detail,
  onAction,
  onDownload,
  onGenerateMedia,
  onReconcileBaijiahao,
  onResolveUnknown,
}: {
  readonly busy: BusyAction | null;
  readonly detail: PublishJobDetail;
  readonly onAction: (action: 'retry' | 'reschedule' | 'cancel') => Promise<void>;
  readonly onDownload: () => Promise<void>;
  readonly onGenerateMedia: () => Promise<void>;
  readonly onReconcileBaijiahao: () => Promise<void>;
  readonly onResolveUnknown: (resolution: 'not_published' | 'published') => Promise<void>;
}) {
  const { job } = detail;
  const externalUrl = safeHttpUrl(job.external_url);
  const retryLimitReached = job.attempt_count >= (job.origin === 'manual' ? 20 : 3);
  return (
    <>
      <section className="mt-5 rounded-2xl border border-line bg-white p-5 shadow-panel sm:p-7">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm text-ink-500">发布详情</p>
            <h2 className="mt-2 text-2xl font-semibold text-ink-950">{statusLabel(job.status)}</h2>
            <p className="mt-2 text-sm text-ink-500">排期：{formatDate(job.scheduled_at)}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            {detail.baijiahao_reconciliation ? (
              <button
                className={primaryButton}
                disabled={busy !== null}
                onClick={() => void onReconcileBaijiahao()}
                type="button"
              >
                {busy === 'reconcile'
                  ? '正在重新核验…'
                  : `重新核验${browserPlatformLabel(detail.baijiahao_reconciliation.platform_code)}状态`}
              </button>
            ) : null}
            {job.status === 'scheduled' &&
            detail.media.supported &&
            detail.media.status === 'none' ? (
              <button
                className={primaryButton}
                disabled={busy !== null}
                onClick={() => void onGenerateMedia()}
                type="button"
              >
                {busy === 'media' ? '正在提交…' : '生成配图'}
              </button>
            ) : null}
            {job.status === 'scheduled' &&
            detail.media.supported &&
            (detail.media.status === 'queued' || detail.media.status === 'running') ? (
              <button className={primaryButton} disabled type="button">
                配图生成中…
              </button>
            ) : null}
            {job.status === 'failed' && detail.unknown_resolution === null && !retryLimitReached ? (
              <button
                className={primaryButton}
                disabled={busy !== null}
                onClick={() => void onAction('retry')}
                type="button"
              >
                {busy === 'retry' ? '正在重试…' : '重试'}
              </button>
            ) : null}
            {job.status === 'cancelled' && !retryLimitReached ? (
              <button
                className={primaryButton}
                disabled={busy !== null}
                onClick={() => void onAction('reschedule')}
                type="button"
              >
                {busy === 'reschedule' ? '正在重新排期…' : '重新排期'}
              </button>
            ) : null}
            {job.status === 'scheduled' ? (
              <button
                className={dangerButton}
                disabled={busy !== null}
                onClick={() => void onAction('cancel')}
                type="button"
              >
                {busy === 'cancel' ? '正在取消…' : '取消未执行任务'}
              </button>
            ) : null}
          </div>
        </div>

        {detail.unknown_resolution ? (
          <div className="mt-5 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
            <h3 className="font-semibold">
              {browserPlatformLabel(detail.unknown_resolution.platform_code)}
              发布结果需要人工核实
            </h3>
            <p className="mt-2 leading-6">
              第 {detail.unknown_resolution.latest_attempt_no}{' '}
              次发布尝试没有取得可安全重试的明确结果。请先在
              {browserPlatformLabel(detail.unknown_resolution.platform_code)}
              内容管理中按标题核对；系统会保留原尝试记录，不会覆盖历史。
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              {detail.unknown_resolution.can_retry ? (
                <button
                  className={primaryButton}
                  disabled={busy !== null}
                  onClick={() => void onResolveUnknown('not_published')}
                  type="button"
                >
                  {busy === 'resolve' ? '正在处理…' : '确认未发布并重试'}
                </button>
              ) : null}
              <button
                className={secondaryButton}
                disabled={busy !== null}
                onClick={() => void onResolveUnknown('published')}
                type="button"
              >
                {busy === 'resolve' ? '正在处理…' : '确认已经发布'}
              </button>
            </div>
            {!detail.unknown_resolution.can_retry ? (
              <p className="mt-3 text-xs leading-5 text-amber-800">
                当前任务已达到发布重试上限，不能继续请求目标平台；仍可在核实后确认已经发布。
              </p>
            ) : null}
          </div>
        ) : null}

        {job.status === 'failed' && retryLimitReached ? (
          <p className="mt-5 rounded-xl bg-amber-50 p-4 text-sm text-amber-900">
            {job.origin === 'manual'
              ? '人工发布已达到 20 次尝试上限，不能继续重试。'
              : '自动发布已达到 3 次尝试上限，不能继续请求外部平台。'}
          </p>
        ) : null}

        {detail.media.status === 'ready' ? (
          <p className="mt-5 rounded-xl bg-emerald-50 p-4 text-sm text-emerald-900">
            已生成 {detail.media.asset_count} 张配图
            {job.status === 'scheduled' ? '，将随文章一起发布。' : '。'}
          </p>
        ) : null}

        <dl className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="任务来源" value={originLabel(job.origin)} />
          <Field label="尝试次数" value={String(job.attempt_count)} />
          <Field
            label="实际发布时间"
            value={job.published_at ? formatDate(job.published_at) : '尚未发布'}
          />
          <div className="rounded-xl bg-surface-subtle p-4">
            <dt className="text-xs font-semibold tracking-wide text-ink-500 uppercase">外部 URL</dt>
            <dd className="mt-2 break-all text-sm text-ink-950">
              {externalUrl ? (
                <a
                  className="text-brand-700 underline"
                  href={externalUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {externalUrl}
                </a>
              ) : job.external_url ? (
                'URL 协议不受支持'
              ) : (
                '尚未生成'
              )}
            </dd>
          </div>
          <Field
            label="最近结果"
            value={job.last_error ? '发布失败，请查看下方记录' : '暂无错误'}
          />
        </dl>
        <div className="mt-5">
          <TechnicalDetails summary="发布技术信息">
            <p>发布任务：{job.id}</p>
            <p>内容版本：{job.content_version_id}</p>
            <p>内容校验值：{job.payload_hash}</p>
            <p>平台内容：{job.variant_id}</p>
            <p>发布账号：{job.account_id}</p>
            <p>平台内容编号：{job.external_post_id ?? '尚未生成'}</p>
            <p>任务版本：{job.version}</p>
            {job.last_error ? <pre>{formatError(job.last_error)}</pre> : null}
          </TechnicalDetails>
        </div>
      </section>

      <AttemptHistory attempts={detail.attempts} />
      <ExportPanel
        artifact={detail.export_artifact}
        downloading={busy === 'download'}
        onDownload={onDownload}
      />
    </>
  );
}

function originLabel(origin: PublishJob['origin']) {
  if (origin === 'official_site_automation') return '官网机器质检通过后自动创建';
  if (origin === 'baijiahao_automation') return '百家号自动化创建';
  if (origin === 'sohu_automation') return '搜狐号自动化创建';
  if (origin === 'lieju_automation') return '列举网自动化创建';
  return '人工创建';
}

function AttemptHistory({ attempts }: { readonly attempts: readonly PublishAttempt[] }) {
  return (
    <section className="mt-5 rounded-2xl border border-line bg-white p-5 shadow-panel sm:p-7">
      <h2 className="text-xl font-semibold text-ink-950">发布记录</h2>
      <p className="mt-2 text-sm text-ink-500">
        每次发布尝试都会保留，便于查看失败原因和处理时间。
      </p>
      {attempts.length === 0 ? (
        <p className="mt-5 rounded-xl bg-surface-subtle p-4 text-sm text-ink-500">
          尚未产生发布尝试。
        </p>
      ) : (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="bg-surface-subtle text-ink-500">
              <tr>
                <th className="p-3">尝试</th>
                <th className="p-3">状态</th>
                <th className="p-3">错误</th>
                <th className="p-3">开始 / 完成</th>
                <th className="p-3">更多</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((attempt) => (
                <tr
                  className="border-t border-line"
                  data-attempt={attempt.attempt_no}
                  key={attempt.id}
                >
                  <td className="p-3 font-semibold">#{attempt.attempt_no}</td>
                  <td className="p-3">{attemptStatusLabel(attempt.status)}</td>
                  <td className="p-3">{attempt.error_code ? '发布未成功' : '无'}</td>
                  <td className="p-3 text-xs">
                    {formatDate(attempt.started_at)}
                    <br />
                    {attempt.finished_at ? formatDate(attempt.finished_at) : '进行中'}
                  </td>
                  <td className="p-3">
                    <TechnicalDetails summary="技术信息">
                      <p>发布适配器：{attempt.adapter_code}</p>
                      <p>请求校验值：{attempt.request_hash}</p>
                      <p>错误代码：{attempt.error_code ?? '无'}</p>
                    </TechnicalDetails>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ExportPanel({
  artifact,
  downloading,
  onDownload,
}: {
  readonly artifact: ExportArtifact | null;
  readonly downloading: boolean;
  readonly onDownload: () => Promise<void>;
}) {
  return (
    <section className="mt-5 rounded-2xl border border-line bg-white p-5 shadow-panel sm:p-7">
      <h2 className="text-xl font-semibold text-ink-950">导出文件</h2>
      {!artifact ? (
        <p className="mt-4 text-sm text-ink-500">当前任务没有可下载的文件。</p>
      ) : (
        <div className="mt-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex-1">
            <p className="text-sm text-ink-600">文件可下载至 {formatDate(artifact.expires_at)}</p>
            <TechnicalDetails summary="导出技术信息">
              <p>导出文件：{artifact.id}</p>
              <p>内容校验值：{artifact.content_hash}</p>
              <p>内容版本：{artifact.content_version_id}</p>
            </TechnicalDetails>
          </div>
          <button
            className={primaryButton}
            disabled={downloading}
            onClick={() => void onDownload()}
            type="button"
          >
            {downloading ? '正在生成地址…' : '下载导出'}
          </button>
        </div>
      )}
    </section>
  );
}

function Field({
  label,
  mono,
  value,
}: {
  readonly label: string;
  readonly mono?: boolean;
  readonly value: string;
}) {
  return (
    <div className="rounded-xl bg-surface-subtle p-4">
      <dt className="text-xs font-semibold tracking-wide text-ink-500 uppercase">{label}</dt>
      <dd className={`mt-2 break-all text-sm text-ink-950 ${mono ? 'font-mono text-xs' : ''}`}>
        {value}
      </dd>
    </div>
  );
}

function StatePanel({
  action,
  text,
  title,
}: {
  readonly action?: React.ReactNode;
  readonly text: string;
  readonly title: string;
}) {
  return (
    <section className="mt-5 rounded-2xl border border-line bg-white p-8 text-center shadow-panel">
      <h2 className="text-xl font-semibold text-ink-950">{title}</h2>
      <p className="mt-3 text-sm text-ink-500">{text}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </section>
  );
}

function readJobId(): string | null {
  if (typeof window === 'undefined') return null;
  const value = new URLSearchParams(window.location.search).get('id');
  return value && UUID_PATTERN.test(value) ? value : null;
}

function safeHttpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function externalIdFromUrl(value: string): string | null {
  const url = new URL(value);
  const externalId = url.searchParams.get('id') ?? url.searchParams.get('nid');
  return externalId && externalId.length <= 240 ? externalId : null;
}

function toIso(value: string | null): string | null {
  if (!value?.trim()) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function toLocalDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function formatError(value: Readonly<Record<string, unknown>> | null) {
  if (!value) return '无';
  return JSON.stringify(value).slice(0, 1000);
}

function statusLabel(status: PublishJob['status']) {
  return STATUS_LABELS[status];
}

function attemptStatusLabel(status: PublishAttempt['status']) {
  return { failed: '失败', running: '进行中', succeeded: '成功', unknown: '外部状态未知' }[status];
}

function browserPlatformLabel(platformCode: 'baijiahao' | 'lieju' | 'sohu'): string {
  return platformCode === 'sohu' ? '搜狐号' : platformCode === 'lieju' ? '列举网' : '百家号';
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function isAccessError(error: unknown) {
  return error instanceof PublishJobDetailRequestError && [401, 403, 404].includes(error.status);
}

function readCookie(name: string) {
  const prefix = `${encodeURIComponent(name)}=`;
  const cookie = document.cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : '';
}

const STATUS_LABELS: Readonly<Record<PublishJob['status'], string>> = {
  cancel_requested: '取消处理中',
  cancelled: '已取消',
  failed: '发布失败',
  published: '已发布',
  publishing: '发布中',
  scheduled: '已排期',
};

const primaryButton =
  'inline-flex h-11 items-center justify-center rounded-control bg-brand-600 px-5 text-sm font-semibold text-white focus:outline-2 focus:outline-offset-2 disabled:opacity-60';
const secondaryButton =
  'inline-flex h-11 items-center justify-center rounded-control border border-line bg-white px-5 text-sm font-semibold text-ink-800 focus:outline-2 focus:outline-offset-2 disabled:opacity-60';
const dangerButton =
  'h-11 rounded-control border border-red-200 bg-white px-4 text-sm font-semibold text-red-700 focus:outline-2 focus:outline-offset-2 disabled:opacity-60';
