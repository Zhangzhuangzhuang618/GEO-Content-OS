'use client';
import { useEffect, useState, type ChangeEvent } from 'react';
import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import { TechnicalDetails } from '../human-readable';
import { listWorkspaces } from '../set-02/workspace-settings-api';
import type { Workspace } from '../set-02/workspace-settings.schema';
import {
  getImportJob,
  MetricsImportRequestError,
  rollbackImport,
  uploadMetrics,
} from './metrics-import-api';
import type { CsvPreview, ImportJob } from './metrics-import.schema';
const ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'analyst']);
const COLUMNS = [
  'platform_code',
  'account_id',
  'variant_id',
  'metric_date',
  'metric_name',
  'metric_value',
] as const;
type Column = (typeof COLUMNS)[number];
export function MetricsImportManager() {
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'permission'>('loading');
  const [workspaces, setWorkspaces] = useState<readonly Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [source, setSource] = useState<{
    headers: string[];
    rows: string[][];
    name: string;
  } | null>(null);
  const [mapping, setMapping] = useState<Record<Column, string>>(emptyMapping);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const tenants = await listAvailableTenants(controller.signal);
        const role = tenants.find((x) => x.is_active)?.role_code;
        if (!role || !ROLES.has(role)) {
          setState('permission');
          return;
        }
        const items = (await listWorkspaces(controller.signal)).filter(
          (x) => x.status === 'active',
        );
        setWorkspaces(items);
        const batchId = readBatch();
        let batch: ImportJob | null = null;
        if (batchId && UUID.test(batchId)) {
          try {
            batch = await getImportJob(batchId, controller.signal);
          } catch (error) {
            if (!(error instanceof MetricsImportRequestError) || error.status !== 404) throw error;
            setMessage('这次导入不存在或不在你的权限范围内。');
          }
        }
        const requestedWorkspace = readWorkspace();
        const selectedWorkspace = batch
          ? batch.workspace_id
          : items.some((item) => item.id === requestedWorkspace)
            ? requestedWorkspace
            : (items[0]?.id ?? '');
        setWorkspaceId(
          items.some((item) => item.id === selectedWorkspace) ? selectedWorkspace : '',
        );
        setJob(batch);
        writeUrl(
          items.some((item) => item.id === selectedWorkspace) ? selectedWorkspace : '',
          batch?.id ?? null,
        );
        if (batchId && !UUID.test(batchId)) {
          setMessage('导入记录链接无效，请从本页重新上传文件。');
        }
        setState('ready');
      } catch (error) {
        if (!controller.signal.aborted) setState(isAccess(error) ? 'permission' : 'error');
      }
    })();
    return () => controller.abort();
  }, []);
  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    setPreview(null);
    setMessage(null);
    if (!file) return;
    try {
      if (!file.name.toLowerCase().endsWith('.csv') || file.size > 10 * 1024 * 1024)
        throw new Error();
      const records = parseCsv(await file.text());
      if (records.length < 2) throw new Error();
      const headers = records[0]!.map((x) => x.trim());
      if (headers.some((header) => !header) || new Set(headers).size !== headers.length)
        throw new Error();
      setSource({ headers, name: file.name, rows: records.slice(1) });
      setMapping(
        Object.fromEntries(
          COLUMNS.map((column) => [column, headers.includes(column) ? column : '']),
        ) as Record<Column, string>,
      );
    } catch {
      setSource(null);
      setMessage('CSV 无法解析，或文件为空、超过 10MB。');
    }
  }
  function validate() {
    if (!source) {
      setMessage('请先选择 CSV 文件。');
      return;
    }
    const selected = COLUMNS.map((c) => mapping[c]);
    if (selected.some((x) => !x) || new Set(selected).size !== selected.length) {
      setMessage('六个目标字段必须映射到不同来源列。');
      return;
    }
    const errors: { line: number; message: string }[] = [];
    const normalized = source.rows.map((row, index) => {
      const values = COLUMNS.map((column) => row[source.headers.indexOf(mapping[column])] ?? '');
      if (
        !PLATFORMS.has(values[0]!) ||
        (values[1]!.trim() !== '' && !UUID.test(values[1]!.trim())) ||
        (values[2]!.trim() !== '' && !UUID.test(values[2]!.trim())) ||
        !validDate(values[3]!) ||
        !/^[a-z][a-z0-9_]{0,63}$/u.test(values[4]!) ||
        values[5]!.trim() === '' ||
        !Number.isFinite(Number(values[5]))
      ) {
        errors.push({ line: index + 2, message: '平台、账号或内容编号、日期、指标名称或数值有误' });
      }
      return values;
    });
    const csv =
      [COLUMNS, ...normalized].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
    const file = errors.length
      ? null
      : new File([csv], `normalized-${source.name}`, { type: 'text/csv' });
    setPreview({ errors, file, headers: [...COLUMNS], rows: normalized.slice(0, 5) });
    setMessage(errors.length ? '校验发现错误行，请修复源文件后重试。' : '校验通过，可提交导入。');
  }
  async function submit() {
    if (!preview?.file || !workspaceId) return;
    const csrf = cookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪。');
      return;
    }
    setBusy(true);
    try {
      const result = await uploadMetrics(preview.file, workspaceId, csrf);
      setJob(result);
      writeUrl(workspaceId, result.id);
      setMessage('数据已提交导入；重复上传同一文件不会产生重复数据。');
    } catch {
      setMessage('导入失败，请检查文件、权限或服务状态。');
    } finally {
      setBusy(false);
    }
  }
  async function rollback() {
    if (!job || job.status !== 'succeeded') return;
    const reason = window.prompt('请输入回滚原因。')?.trim() ?? '';
    if (!reason) return;
    if (reason.length > 1_000) {
      setMessage('回滚原因不能超过 1000 个字符。');
      return;
    }
    const csrf = cookie('geo_csrf');
    if (!csrf) return;
    setBusy(true);
    try {
      setJob(await rollbackImport(job, reason, csrf));
      setMessage('本次导入已撤销；历史记录会保留，但不再进入汇总数据。');
    } catch {
      setMessage('撤销失败，导入状态可能已变化。');
    } finally {
      setBusy(false);
    }
  }
  function chooseWorkspace(id: string) {
    setWorkspaceId(id);
    if (job?.workspace_id !== id) setJob(null);
    writeUrl(id, job?.workspace_id === id ? job.id : null);
  }
  if (state === 'loading') return <Panel title="正在加载指标导入" text="正在读取权限和工作区。" />;
  if (state === 'permission')
    return <Panel title="无权导入指标" text="仅分析师、企业管理员和所有者可访问。" />;
  if (state === 'error')
    return <Panel title="无法加载指标导入" text="请检查网络、权限或服务状态。" />;
  if (workspaces.length === 0)
    return <Panel title="暂无可用工作区" text="请先创建或启用工作区，再导入指标。" />;
  return (
    <section className="mt-8">
      <section className="rounded-2xl border border-line bg-white p-5 shadow-panel sm:p-7">
        <h2 className="text-xl font-semibold">文件与映射</h2>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <label className={label}>
            工作区
            <select
              className={control}
              value={workspaceId}
              onChange={(e) => chooseWorkspace(e.currentTarget.value)}
            >
              <option value="">请选择</option>
              {workspaces.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            CSV 文件
            <input
              accept=".csv,text/csv"
              className={control}
              onChange={(e) => void chooseFile(e)}
              type="file"
            />
          </label>
        </div>
        {source ? (
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {COLUMNS.map((column) => (
              <label className={label} key={column}>
                {columnLabel(column)}
                <select
                  className={control}
                  value={mapping[column]}
                  onChange={(e) => setMapping({ ...mapping, [column]: e.currentTarget.value })}
                >
                  <option value="">请选择来源列</option>
                  {source.headers.map((header) => (
                    <option key={header} value={header}>
                      {header}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        ) : null}
        <div className="mt-5 flex gap-3">
          <button className={secondary} onClick={validate} type="button">
            校验并预览
          </button>
          <button
            className={primary}
            disabled={!preview?.file || !workspaceId || busy}
            onClick={() => void submit()}
            type="button"
          >
            导入
          </button>
        </div>
      </section>
      <div aria-live="polite" className="mt-4 min-h-6 text-sm">
        {message}
      </div>
      {preview ? (
        <Preview value={preview} />
      ) : (
        <Panel title="暂无预览" text="选择文件并完成列映射后校验。" />
      )}
      {job ? (
        <Batch job={job} busy={busy} onRollback={() => void rollback()} />
      ) : (
        <Panel title="暂无导入记录" text="选择文件并提交导入后，可在这里查看处理结果。" />
      )}
    </section>
  );
}
function Preview({ value }: { readonly value: CsvPreview }) {
  return (
    <section className="mt-5 rounded-2xl border border-line bg-white p-5 shadow-panel">
      <h2 className="text-xl font-semibold">预览与错误行</h2>
      {value.errors.length ? (
        <ul className="mt-4 text-sm text-red-700">
          {value.errors.map((x) => (
            <li key={`${x.line}-${x.message}`}>
              第 {x.line} 行：{x.message}
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-[900px] text-sm">
            <thead>
              <tr>
                {value.headers.map((x) => (
                  <th className="p-2" key={x}>
                    {columnLabel(x as Column)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {value.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td className="border-t p-2" key={j}>
                      {cell || '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
function Batch({
  job,
  busy,
  onRollback,
}: {
  readonly job: ImportJob;
  readonly busy: boolean;
  readonly onRollback: () => void;
}) {
  const errors = Array.isArray(job.error_json?.['rows']) ? job.error_json['rows'] : [];
  return (
    <section className="mt-5 rounded-2xl border border-line bg-white p-5 shadow-panel">
      <h2 className="text-xl font-semibold">导入结果</h2>
      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="状态" value={importStatusLabel(job.status)} />
        <Field label="数据行数" value={job.row_count === null ? '—' : String(job.row_count)} />
      </dl>
      {errors.length ? (
        <pre className="mt-4 overflow-auto rounded bg-red-50 p-3 text-xs">
          {JSON.stringify(errors, null, 2)}
        </pre>
      ) : null}
      <TechnicalDetails summary="导入技术信息">
        <p>导入编号：{job.id}</p>
        <p>内容校验值：{job.content_hash ?? '—'}</p>
      </TechnicalDetails>
      {job.status === 'succeeded' ? (
        <button className={danger} disabled={busy} onClick={onRollback} type="button">
          撤销本次导入
        </button>
      ) : null}
    </section>
  );
}
function Field({ label: heading, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-500">{heading}</dt>
      <dd className="mt-1 break-all text-sm">{value}</dd>
    </div>
  );
}
function Panel({ title, text }: { readonly title: string; readonly text: string }) {
  return (
    <section className="mt-5 rounded-2xl border border-line bg-white p-8 text-center shadow-panel">
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="mt-3 text-sm text-ink-500">{text}</p>
    </section>
  );
}
function columnLabel(value: Column): string {
  return {
    platform_code: '平台',
    account_id: '平台账号编号（可选）',
    variant_id: '平台内容编号（可选）',
    metric_date: '数据日期',
    metric_name: '指标名称',
    metric_value: '指标数值',
  }[value];
}
function importStatusLabel(value: ImportJob['status']): string {
  return (
    {
      queued: '等待处理',
      running: '正在导入',
      succeeded: '导入完成',
      failed: '导入失败',
      rolled_back: '已撤销',
    }[value] ?? value
  );
}
function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((x) => x.length)) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (quoted) throw new Error();
  row.push(cell);
  if (row.some((x) => x.length)) rows.push(row);
  return rows;
}
function csvCell(value: string) {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
function emptyMapping() {
  return Object.fromEntries(COLUMNS.map((x) => [x, ''])) as Record<Column, string>;
}
function cookie(name: string) {
  const prefix = `${name}=`;
  return (
    document.cookie
      .split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith(prefix))
      ?.slice(prefix.length) ?? ''
  );
}
function readBatch() {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(location.search).get('batch_id');
}
function readWorkspace() {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(location.search).get('workspace_id') ?? '';
}
function writeUrl(workspace: string, batch: string | null) {
  const query = new URLSearchParams();
  if (workspace) query.set('workspace_id', workspace);
  if (batch) query.set('batch_id', batch);
  const suffix = query.size ? `?${query}` : '';
  history.replaceState(null, '', `/anl-02${suffix}`);
}
function isAccess(error: unknown) {
  return error instanceof MetricsImportRequestError && [401, 403, 404].includes(error.status);
}
function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PLATFORMS = new Set([
  'official_site',
  'baijiahao',
  'sohu',
  'lieju',
  'toutiao',
  'zhihu',
  'xiaohongshu',
  'wechat_mp',
  'douyin',
]);
const label = 'text-sm text-ink-700';
const control = 'mt-2 block h-11 w-full rounded-control border border-line bg-white px-3 text-sm';
const primary =
  'h-11 rounded-control bg-brand-600 px-5 text-sm font-semibold text-white disabled:opacity-60';
const secondary =
  'h-11 rounded-control border border-line bg-white px-4 text-sm font-semibold disabled:opacity-60';
const danger =
  'mt-5 h-11 rounded-control border border-red-200 px-4 text-sm font-semibold text-red-700 disabled:opacity-60';
