'use client';

import { useEffect, useState } from 'react';

import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import { TechnicalDetails } from '../human-readable';
import {
  expireSource,
  getSourceDetail,
  retrySource,
  SourceDetailRequestError,
} from './source-detail-api';
import type {
  Chunk,
  Fact,
  IngestJob,
  Source,
  SourceDetailScope,
  SourceDetailView,
} from './source-detail.schema';

const MANAGER_ROLES = new Set<TenantRole>([
  'tenant_owner',
  'tenant_admin',
  'strategy_editor',
  'content_editor',
]);

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'missing-scope' }
  | { readonly status: 'permission' }
  | { readonly status: 'error' }
  | {
      readonly detail: SourceDetailView;
      readonly role: TenantRole | null;
      readonly status: 'ready';
    };

export function SourceDetail() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [busy, setBusy] = useState<'retry' | 'expire' | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const scope = readScope();
    if (!scope) {
      setState({ status: 'missing-scope' });
      return;
    }
    const controller = new AbortController();
    void load(scope, controller.signal);
    return () => controller.abort();

    async function load(nextScope: SourceDetailScope, signal: AbortSignal) {
      try {
        const [tenants, detail] = await Promise.all([
          listAvailableTenants(signal),
          getSourceDetail(nextScope, signal),
        ]);
        if (signal.aborted) return;
        setState({
          detail,
          role: tenants.find((tenant) => tenant.is_active)?.role_code ?? null,
          status: 'ready',
        });
      } catch (error) {
        if (signal.aborted) return;
        setState({
          status:
            error instanceof SourceDetailRequestError && error.status === 403
              ? 'permission'
              : 'error',
        });
      }
    }
  }, []);

  useEffect(() => {
    if (state.status !== 'ready' || state.detail.source.status !== 'processing') return;
    const scope = readScope();
    if (!scope) return;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const detail = await getSourceDetail(scope, controller.signal);
        if (!controller.signal.aborted) setState({ detail, role: state.role, status: 'ready' });
      } catch {
        // Keep the last readable state; the next interval can recover from a transient failure.
      }
    };
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [state]);

  if (state.status === 'loading') return <DetailSkeleton />;
  if (state.status === 'missing-scope')
    return <StatePanel title="缺少资料范围" text="请返回资料列表并从对应资料进入详情。" />;
  if (state.status === 'permission')
    return <StatePanel title="无权查看资料" text="当前工作区权限不允许访问该资料。" />;
  if (state.status === 'error')
    return <StatePanel title="无法加载资料" text="资料不存在、范围不匹配或网络异常。" />;

  const canManage = state.role !== null && MANAGER_ROLES.has(state.role);
  const { detail } = state;
  const readyRole = state.role;

  async function mutate(operation: 'retry' | 'expire') {
    if (busy || detail.source.status === 'expired') return;
    if (operation === 'expire' && !window.confirm(`确认将“${detail.source.title}”标记为失效？`))
      return;
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    setBusy(operation);
    setMessage(null);
    try {
      if (operation === 'retry') {
        await retrySource(detail.source, csrf);
        setState({
          detail: { ...detail, source: { ...detail.source, status: 'processing' } },
          role: readyRole,
          status: 'ready',
        });
        setMessage('已重新开始处理资料，稍后刷新页面可查看进度。');
      } else {
        await expireSource(detail.source, csrf);
        setState({
          detail: { ...detail, source: { ...detail.source, status: 'expired' } },
          role: readyRole,
          status: 'ready',
        });
        setMessage('资料已失效，不会进入新的检索。');
      }
    } catch {
      setMessage('操作失败，资料状态可能已变化，请刷新后重试。');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mt-8 space-y-5">
      <section className="rounded-2xl border border-line bg-white p-5 shadow-panel sm:p-7">
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={detail.source.status} />
              <span className="text-xs font-semibold text-ink-500">
                {trustLabel(detail.source.trust_level)}
              </span>
            </div>
            <h2 className="mt-3 text-2xl font-semibold text-ink-950">{detail.source.title}</h2>
          </div>
          {canManage && detail.source.status !== 'expired' ? (
            <div className="flex flex-wrap gap-2">
              <button
                className={secondaryButton}
                disabled={busy !== null}
                onClick={() => void mutate('retry')}
                type="button"
              >
                重试解析
              </button>
              <button
                className={dangerButton}
                disabled={busy !== null}
                onClick={() => void mutate('expire')}
                type="button"
              >
                标记失效
              </button>
            </div>
          ) : null}
        </div>
        <dl className="mt-6 grid gap-4 border-t border-line pt-5 sm:grid-cols-2 lg:grid-cols-4">
          <Detail
            label="资料类型"
            value={
              detail.certificate
                ? '企业证照'
                : detail.insurance_proof
                  ? '保险证明'
                  : sourceTypeLabel(detail.source.source_type)
            }
          />
          <Detail label="语言" value={detail.source.language} />
          <Detail label="有效期" value={effectiveRange(detail.source)} />
          <Detail label="引用次数" value={String(detail.citation_count)} />
          <Detail label="更新时间" value={formatDateTime(detail.source.updated_at)} />
        </dl>
        {detail.certificate ? (
          <section className="mt-5 rounded-xl border border-line bg-surface-subtle p-4">
            <h3 className="font-semibold text-ink-950">证照核验信息</h3>
            <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Detail label="证照名称" value={detail.certificate.certificate_name} />
              <Detail label="证照编号" value={detail.certificate.certificate_number} />
              <Detail label="持证主体" value={detail.certificate.holder_name} />
              <Detail label="发证机关" value={detail.certificate.issuing_authority} />
              <Detail
                label="文章展示"
                value={detail.certificate.article_use_allowed ? '已授权（仅正文引用时）' : '未授权'}
              />
              <Detail
                label="公开内容确认"
                value={detail.certificate.public_display_confirmed ? '已确认' : '未确认'}
              />
            </dl>
            {detail.certificate.verification_url ? (
              <a
                className="mt-4 inline-flex text-sm font-semibold text-brand-700 underline"
                href={detail.certificate.verification_url}
                rel="noreferrer"
                target="_blank"
              >
                打开官方核验链接
              </a>
            ) : null}
          </section>
        ) : null}
        {detail.insurance_proof ? (
          <section className="mt-5 rounded-xl border border-line bg-surface-subtle p-4">
            <h3 className="font-semibold text-ink-950">保险证明脱敏摘要</h3>
            <p className="mt-2 text-xs leading-5 text-ink-500">
              原始 PDF
              保存在私有对象存储，不进入检索、模型上下文或文章素材；下列人工确认字段生成的摘要可参与检索和生文。
            </p>
            <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Detail label="投保主体" value={detail.insurance_proof.policyholder_name} />
              <Detail label="承保机构" value={detail.insurance_proof.insurer_name} />
              <Detail label="保险类型" value={detail.insurance_proof.insurance_type} />
              <Detail label="参保人数" value={`${detail.insurance_proof.insured_count} 人`} />
              <Detail label="保障期间" value={effectiveRange(detail.source)} />
              <Detail label="原件公开" value="禁止" />
            </dl>
          </section>
        ) : null}
        <div className="mt-5">
          <TechnicalDetails summary="资料技术信息">
            <p>资料编号：{detail.source.id}</p>
            <p>工作区：{detail.source.workspace_id}</p>
            <p>项目：{detail.source.project_id ?? '工作区共享'}</p>
            <p>文件格式：{detail.source.mime_type}</p>
            <p>内容校验值：{detail.source.content_hash}</p>
          </TechnicalDetails>
        </div>
      </section>

      <Section title="处理进度" count={detail.ingest_jobs.length}>
        {detail.ingest_jobs.length === 0 ? (
          <EmptyText>暂无处理记录。</EmptyText>
        ) : (
          <ol className="divide-y divide-line">
            {detail.ingest_jobs.map((job) => (
              <JobRow job={job} key={job.id} />
            ))}
          </ol>
        )}
      </Section>

      <Section
        title={detail.insurance_proof ? '可检索脱敏摘要' : '原文片段'}
        count={detail.chunks.length}
      >
        {detail.chunks.length === 0 ? (
          <EmptyText>尚未提取可用的原文片段。</EmptyText>
        ) : (
          <ol className="space-y-4" aria-label="资料原文片段">
            {detail.chunks.map((chunk) => (
              <ChunkCard chunk={chunk} key={chunk.id} sourceId={detail.source.id} />
            ))}
          </ol>
        )}
      </Section>

      <Section title="关联事实" count={detail.facts.length}>
        {detail.facts.length === 0 ? (
          <EmptyText>暂无关联事实。</EmptyText>
        ) : (
          <ul className="divide-y divide-line" aria-label="关联事实列表">
            {detail.facts.map((fact) => (
              <FactRow fact={fact} key={fact.id} />
            ))}
          </ul>
        )}
      </Section>

      <div aria-live="polite" className="min-h-10">
        {message ? (
          <p className="rounded-control bg-brand-50 px-3 py-2 text-sm text-brand-700" role="status">
            {message}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function JobRow({ job }: { job: IngestJob }) {
  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-ink-950">
          {stageLabel(job.stage)} · {job.progress}%
        </p>
        <span className="text-xs text-ink-500">
          {jobStatusLabel(job.status)} · 第 {job.attempt_count + 1} 次处理
        </span>
      </div>
      <p className="mt-2 text-xs text-ink-500">
        {formatDateTime(job.started_at)} — {formatDateTime(job.finished_at)}
      </p>
      {job.error ? (
        <>
          <p className="mt-2 text-sm text-red-700">处理失败，请重试或检查原始资料。</p>
          <TechnicalDetails summary="失败技术信息">
            <p>
              {job.error.code}：{job.error.message}
            </p>
          </TechnicalDetails>
        </>
      ) : null}
    </li>
  );
}

function ChunkCard({ chunk, sourceId }: { chunk: Chunk; sourceId: string }) {
  const sameSource = chunk.source_document_id === sourceId;
  return (
    <li className="rounded-xl border border-line bg-surface-subtle p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-ink-950">第 {chunk.chunk_no + 1} 段</h3>
        <span className="text-xs text-ink-500">{chunkLocation(chunk)}</span>
      </div>
      <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-ink-700">{chunk.text}</p>
      {!sameSource ? (
        <p className="mt-3 text-xs font-semibold text-red-700">该片段的来源校验异常。</p>
      ) : null}
      <div className="mt-4">
        <TechnicalDetails summary="片段技术信息">
          <p>片段编号：{chunk.id}</p>
          <p>来源资料：{chunk.source_document_id}</p>
          <p>文本校验值：{chunk.text_hash}</p>
          <p>文本长度：{chunk.token_count} tokens</p>
          <p>处理状态：{chunk.status}</p>
        </TechnicalDetails>
      </div>
    </li>
  );
}

function FactRow({ fact }: { fact: Fact }) {
  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-semibold text-ink-950">
          {fact.subject} · {fact.predicate}
        </p>
        <span className="rounded-full bg-brand-50 px-2 py-1 text-xs font-semibold text-brand-700">
          {factStatusLabel(fact.status)}
        </span>
      </div>
      <p className="mt-2 text-sm text-ink-700">
        {fact.object_value}
        {fact.unit ? ` ${fact.unit}` : ''}
      </p>
      <p className="mt-2 text-xs text-ink-500">
        置信度 {Math.round(fact.confidence * 100)}% · 证据 {fact.evidence?.length ?? 0} 条
      </p>
    </li>
  );
}

function Section({
  children,
  count,
  title,
}: {
  children: React.ReactNode;
  count: number;
  title: string;
}) {
  return (
    <section className="rounded-2xl border border-line bg-white p-5 shadow-panel sm:p-7">
      <h2 className="text-xl font-semibold text-ink-950">
        {title} <span className="text-sm font-normal text-ink-500">({count})</span>
      </h2>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Detail({ label, mono = false, value }: { label: string; mono?: boolean; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className={`mt-1 break-all text-sm text-ink-700 ${mono ? 'font-mono text-xs' : ''}`}>
        {value}
      </dd>
    </div>
  );
}

function EmptyText({ children }: { children: React.ReactNode }) {
  return <p className="py-5 text-center text-sm text-ink-500">{children}</p>;
}

function StatusBadge({ status }: { status: Source['status'] }) {
  const labels = {
    processing: '解析中',
    active: '有效',
    expired: '已失效',
    failed: '失败',
  } as const;
  return (
    <span className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700">
      {labels[status]}
    </span>
  );
}

function StatePanel({ text, title }: { text: string; title: string }) {
  return (
    <section className="mt-8 rounded-2xl border border-line bg-white p-8 text-center shadow-panel">
      <h2 className="text-xl font-semibold text-ink-950">{title}</h2>
      <p className="mt-3 text-sm text-ink-500">{text}</p>
    </section>
  );
}

function DetailSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="正在加载资料详情"
      className="mt-8 h-96 animate-pulse rounded-2xl border border-line bg-white"
    />
  );
}

function readScope(): SourceDetailScope | null {
  if (typeof window === 'undefined') return null;
  const query = new URLSearchParams(window.location.search);
  const id = query.get('id');
  const projectId = query.get('project_id');
  const workspaceId = query.get('workspace_id');
  return id && projectId && workspaceId ? { id, projectId, workspaceId } : null;
}

function chunkLocation(chunk: Chunk): string {
  if (chunk.metadata.page)
    return `第 ${chunk.metadata.page} 页，字符 ${chunk.metadata.char_start}-${chunk.metadata.char_end}`;
  if (chunk.metadata.url)
    return `${chunk.metadata.url}，字符 ${chunk.metadata.char_start}-${chunk.metadata.char_end}`;
  return `字符 ${chunk.metadata.char_start}-${chunk.metadata.char_end}`;
}

function effectiveRange(source: Source): string {
  return `${source.effective_from ?? '未限定'} — ${source.effective_to ?? '长期'}`;
}

function stageLabel(stage: IngestJob['stage']): string {
  return {
    queued: '排队',
    upload: '上传',
    scan: '扫描',
    parse: '读取内容',
    chunk: '整理段落',
    embed: '理解内容',
    index: '建立检索',
    done: '完成',
  }[stage];
}

function jobStatusLabel(value: IngestJob['status']): string {
  return (
    {
      queued: '等待处理',
      running: '处理中',
      succeeded: '处理完成',
      failed: '处理失败',
      cancelled: '已取消',
    }[value] ?? value
  );
}

function factStatusLabel(value: Fact['status']): string {
  return {
    candidate: '待确认',
    verified: '已确认',
    conflicted: '有争议',
    retired: '已停用',
  }[value];
}

function sourceTypeLabel(value: Source['source_type']): string {
  return {
    pdf: 'PDF 文档',
    docx: 'Word 文档',
    txt: '文本文件',
    url: '网页链接',
    image: '图片',
  }[value];
}

function trustLabel(value: Source['trust_level']): string {
  return { verified: '已验证可信', normal: '普通可信', untrusted: '不可信' }[value];
}

function formatDateTime(value: string | null): string {
  return value
    ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      )
    : '—';
}

function readCookie(name: string): string {
  const prefix = `${encodeURIComponent(name)}=`;
  const cookie = document.cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : '';
}

const secondaryButton =
  'h-10 rounded-control border border-brand-600 px-4 text-sm font-semibold text-brand-700 disabled:opacity-60';
const dangerButton =
  'h-10 rounded-control border border-red-300 px-4 text-sm font-semibold text-red-700 disabled:opacity-60';
