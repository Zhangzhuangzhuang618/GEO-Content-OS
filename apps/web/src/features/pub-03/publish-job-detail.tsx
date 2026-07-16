'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import type { PublishJob } from '../pub-02/publishing-calendar.schema';
import {
  cancelUnexecutedPublishJob,
  getPublishJobDetail,
  getSignedExport,
  PublishJobDetailRequestError,
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

export function PublishJobDetailView() {
  const [jobId, setJobId] = useState(readJobId);
  const [detail, setDetail] = useState<PublishJobDetail | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error' | 'permission'>(
    'loading',
  );
  const [busy, setBusy] = useState<'retry' | 'cancel' | 'download' | null>(null);
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

  function openJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextId = String(new FormData(event.currentTarget).get('job_id') ?? '').trim();
    if (!UUID_PATTERN.test(nextId)) {
      setMessage('请输入有效的发布任务 UUID。');
      return;
    }
    window.history.replaceState(null, '', `/pub-03?id=${encodeURIComponent(nextId)}`);
    setJobId(nextId);
  }

  async function runAction(action: 'retry' | 'cancel') {
    if (!detail) return;
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    let reason = '';
    if (action === 'cancel') {
      reason = window.prompt('请输入取消原因。')?.trim() ?? '';
      if (!reason) return;
    }
    setBusy(action);
    setMessage(null);
    try {
      if (action === 'retry') await retryPublishJob(detail.job, csrf);
      if (action === 'cancel') await cancelUnexecutedPublishJob(detail.job, reason, csrf);
      setMessage(action === 'retry' ? '发布重试已排队。' : '未执行任务已取消。');
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

  return (
    <section className="mt-8">
      <form
        aria-label="打开发布任务"
        className="flex flex-col gap-3 rounded-2xl border border-line bg-white p-4 shadow-panel sm:flex-row sm:items-end"
        onSubmit={openJob}
      >
        <label className="flex-1 text-sm text-ink-700">
          发布任务 UUID
          <input
            className={controlClass}
            defaultValue={jobId ?? ''}
            name="job_id"
            placeholder="xxxxxxxx-xxxx-..."
          />
        </label>
        <button className={primaryButton} type="submit">
          打开任务
        </button>
      </form>

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
        <StatePanel title="正在加载发布任务" text="正在读取冻结 Payload、尝试和导出制品。" />
      ) : state === 'permission' ? (
        <StatePanel title="无权查看发布任务" text="仅发布人、租户管理员和所有者可访问。" />
      ) : state === 'error' ? (
        <StatePanel title="无法加载发布任务" text="任务不存在、超出授权范围或服务暂不可用。" />
      ) : state === 'empty' || !detail ? (
        <StatePanel title="请选择发布任务" text="输入发布任务 UUID 后查看详情。" />
      ) : (
        <DetailContent
          busy={busy}
          detail={detail}
          onAction={runAction}
          onDownload={prepareDownload}
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
}: {
  readonly busy: 'retry' | 'cancel' | 'download' | null;
  readonly detail: PublishJobDetail;
  readonly onAction: (action: 'retry' | 'cancel') => Promise<void>;
  readonly onDownload: () => Promise<void>;
}) {
  const { job } = detail;
  const externalUrl = safeHttpUrl(job.external_url);
  return (
    <>
      <section className="mt-5 rounded-2xl border border-line bg-white p-5 shadow-panel sm:p-7">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm text-ink-500">任务 {job.id}</p>
            <h2 className="mt-2 text-2xl font-semibold text-ink-950">{statusLabel(job.status)}</h2>
            <p className="mt-2 text-sm text-ink-500">排期：{formatDate(job.scheduled_at)}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            {job.status === 'failed' ? (
              <button
                className={primaryButton}
                disabled={busy !== null}
                onClick={() => void onAction('retry')}
                type="button"
              >
                {busy === 'retry' ? '正在重试…' : '重试'}
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

        <dl className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Payload 内容版本" value={job.content_version_id} mono />
          <Field label="Payload Hash" value={job.payload_hash} mono />
          <Field label="变体" value={job.variant_id} mono />
          <Field label="账号" value={job.account_id} mono />
          <Field label="尝试次数" value={String(job.attempt_count)} />
          <Field label="外部 post_id" value={job.external_post_id ?? '尚未生成'} mono />
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
          <Field label="最后错误" value={formatError(job.last_error)} />
          <Field label="任务版本" value={String(job.version)} />
        </dl>
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

function AttemptHistory({ attempts }: { readonly attempts: readonly PublishAttempt[] }) {
  return (
    <section className="mt-5 rounded-2xl border border-line bg-white p-5 shadow-panel sm:p-7">
      <h2 className="text-xl font-semibold text-ink-950">发布尝试（append-only）</h2>
      <p className="mt-2 text-sm text-ink-500">
        历史尝试按 attempt_no 展示，前端只读且不覆盖旧记录。
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
                <th className="p-3">Adapter</th>
                <th className="p-3">状态</th>
                <th className="p-3">错误</th>
                <th className="p-3">请求 Hash</th>
                <th className="p-3">开始 / 完成</th>
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
                  <td className="p-3">{attempt.adapter_code}</td>
                  <td className="p-3">{attemptStatusLabel(attempt.status)}</td>
                  <td className="p-3">{attempt.error_code ?? '无'}</td>
                  <td className="p-3 font-mono text-xs">{attempt.request_hash}</td>
                  <td className="p-3 text-xs">
                    {formatDate(attempt.started_at)}
                    <br />
                    {attempt.finished_at ? formatDate(attempt.finished_at) : '进行中'}
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
      <h2 className="text-xl font-semibold text-ink-950">确定性导出包</h2>
      {!artifact ? (
        <p className="mt-4 text-sm text-ink-500">当前任务没有可用导出制品。</p>
      ) : (
        <div className="mt-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <dl className="grid flex-1 gap-4 sm:grid-cols-2">
            <Field label="制品 ID" value={artifact.id} mono />
            <Field label="内容 Hash" value={artifact.content_hash} mono />
            <Field label="内容版本" value={artifact.content_version_id} mono />
            <Field label="元数据有效期" value={formatDate(artifact.expires_at)} />
          </dl>
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

function StatePanel({ text, title }: { readonly text: string; readonly title: string }) {
  return (
    <section className="mt-5 rounded-2xl border border-line bg-white p-8 text-center shadow-panel">
      <h2 className="text-xl font-semibold text-ink-950">{title}</h2>
      <p className="mt-3 text-sm text-ink-500">{text}</p>
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

const controlClass =
  'mt-2 block h-11 w-full rounded-control border border-line bg-white px-3 text-sm text-ink-950 focus:border-brand-500 focus:outline-2 focus:outline-offset-2 disabled:bg-surface-subtle';
const primaryButton =
  'h-11 rounded-control bg-brand-600 px-5 text-sm font-semibold text-white focus:outline-2 focus:outline-offset-2 disabled:opacity-60';
const dangerButton =
  'h-11 rounded-control border border-red-200 bg-white px-4 text-sm font-semibold text-red-700 focus:outline-2 focus:outline-offset-2 disabled:opacity-60';
