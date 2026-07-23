'use client';

import {
  useEffect,
  useState,
  type ChangeEvent,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import { listWorkspaces } from '../set-02/workspace-settings-api';
import type { Workspace } from '../set-02/workspace-settings.schema';
import {
  createVisibilityObservation,
  importVisibilityObservations,
  loadVisibilityTrend,
  VisibilityRequestError,
} from './visibility-api';
import type {
  Observation,
  Platform,
  TrendPoint,
  VisibilityFilters,
  VisibilityInput,
} from './visibility.schema';

const ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'analyst']);
const PLATFORMS: readonly [Platform, string][] = [
  ['official_site', '官网'],
  ['baijiahao', '百家号'],
  ['toutiao', '头条号'],
  ['zhihu', '知乎'],
  ['xiaohongshu', '小红书'],
  ['wechat_mp', '微信公众号'],
  ['douyin', '抖音'],
];
const PLATFORM_CODES = new Set(PLATFORMS.map(([code]) => code));
const CSV_REQUIRED = ['query_text', 'platform_code', 'rank_position', 'is_cited', 'observed_at'];

export function VisibilityManager() {
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error' | 'permission'>(
    'loading',
  );
  const [trendState, setTrendState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [workspaces, setWorkspaces] = useState<readonly Workspace[]>([]);
  const [filters, setFilters] = useState<VisibilityFilters>(readFilters);
  const [trend, setTrend] = useState<readonly TrendPoint[]>([]);
  const [latest, setLatest] = useState<Observation | null>(null);
  const [importRows, setImportRows] = useState<readonly VisibilityInput[]>([]);
  const [importName, setImportName] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const tenants = await listAvailableTenants(controller.signal);
        const role = tenants.find((item) => item.is_active)?.role_code;
        if (!role || !ROLES.has(role)) {
          setState('permission');
          return;
        }
        const items = (await listWorkspaces(controller.signal)).filter(
          (item) => item.status === 'active',
        );
        setWorkspaces(items);
        if (items.length === 0) {
          setState('empty');
          return;
        }
        const selected = items.some((item) => item.id === filters.workspaceId)
          ? filters.workspaceId
          : items[0]!.id;
        const next = { ...filters, workspaceId: selected };
        setFilters(next);
        writeFilters(next);
        setState('ready');
        await loadTrend(next, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) setState(isAccess(error) ? 'permission' : 'error');
      }
    })();
    return () => controller.abort();
  }, []);

  async function loadTrend(next: VisibilityFilters, signal?: AbortSignal) {
    setTrendState('loading');
    try {
      const response = await loadVisibilityTrend(next, signal);
      if (signal?.aborted) return;
      setTrend(response.data);
      setTrendState('ready');
    } catch (error) {
      if (!signal?.aborted) {
        setTrendState('error');
        if (isAccess(error)) setState('permission');
      }
    }
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const next: VisibilityFilters = {
      from: String(data.get('from') ?? ''),
      ...(PLATFORM_CODES.has(String(data.get('platform_code')) as Platform)
        ? { platformCode: String(data.get('platform_code')) as Platform }
        : {}),
      ...(String(data.get('query_text') ?? '').trim()
        ? { queryText: String(data.get('query_text')).trim() }
        : {}),
      to: String(data.get('to') ?? ''),
      workspaceId: String(data.get('workspace_id') ?? ''),
    };
    setFilters(next);
    writeFilters(next);
    void loadTrend(next);
  }

  async function record(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const screenshot = data.get('screenshot');
    const file = screenshot instanceof File && screenshot.size > 0 ? screenshot : null;
    if (
      file &&
      (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 512 * 1024)
    ) {
      setMessage('截图仅支持 JPEG、PNG、WebP，且不能超过 512KB。');
      return;
    }
    const csrf = cookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪。');
      return;
    }
    const rank = String(data.get('rank_position') ?? '').trim();
    const notes = String(data.get('notes') ?? '').trim();
    const input: VisibilityInput = {
      is_cited: data.get('is_cited') === 'on',
      ...(notes ? { notes } : {}),
      observed_at: new Date(String(data.get('observed_at'))).toISOString(),
      platform_code: String(data.get('platform_code')) as Platform,
      query_text: String(data.get('query_text') ?? '').trim(),
      ...(rank ? { rank_position: Number(rank) } : {}),
    };
    setBusy(true);
    setMessage(null);
    try {
      const created = await createVisibilityObservation(filters.workspaceId, input, file, csrf);
      setLatest(created);
      setMessage(file ? '观察已录入，截图已保存为对象存储证据。' : '观察已录入。');
      await loadTrend(filters);
    } catch {
      setMessage('录入失败，请检查字段、权限或服务状态。');
    } finally {
      setBusy(false);
    }
  }

  async function chooseCsv(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    setImportRows([]);
    setImportName('');
    if (!file) return;
    try {
      if (!file.name.toLowerCase().endsWith('.csv') || file.size > 1024 * 1024) throw new Error();
      const records = parseCsv(await file.text());
      if (records.length < 2 || records.length > 1_001) throw new Error();
      const headers = records[0]!.map((value, index) =>
        (index === 0 ? value.replace(/^\uFEFF/u, '') : value).trim(),
      );
      if (
        headers.some((header) => !header) ||
        new Set(headers).size !== headers.length ||
        CSV_REQUIRED.some((header) => !headers.includes(header))
      )
        throw new Error();
      const rows = records.slice(1).map((row) => csvObservation(headers, row));
      setImportRows(rows);
      setImportName(file.name);
      setMessage(`CSV 校验通过，共 ${rows.length} 行。`);
    } catch {
      setMessage('CSV 无法解析；请检查必需列、字段格式、1000 行和 1MB 限制。');
    }
  }

  async function importCsv() {
    if (importRows.length === 0) return;
    const csrf = cookie('geo_csrf');
    if (!csrf) return;
    setBusy(true);
    try {
      const created = await importVisibilityObservations(filters.workspaceId, importRows, csrf);
      setLatest(created.at(-1) ?? null);
      setMessage(`已导入 ${created.length} 条观察。`);
      await loadTrend(filters);
    } catch {
      setMessage('导入失败；所有行已原子回滚，请修复后重试。');
    } finally {
      setBusy(false);
    }
  }

  if (state === 'loading')
    return <Panel title="正在加载可见性观察" text="正在读取权限和工作区。" />;
  if (state === 'permission')
    return <Panel title="无权访问可见性观察" text="仅分析师、企业管理员和所有者可访问。" />;
  if (state === 'error')
    return <Panel title="无法加载可见性观察" text="请检查网络、权限或服务状态。" />;
  if (state === 'empty') return <Panel title="暂无可用工作区" text="请先创建或启用工作区。" />;

  return (
    <section className="mt-8 space-y-5">
      <FilterForm filters={filters} onSubmit={applyFilters} workspaces={workspaces} />
      <div aria-live="polite" className="min-h-6 text-sm">
        {message}
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <RecordForm busy={busy} onSubmit={record} />
        <ImportPanel
          busy={busy}
          fileName={importName}
          onChoose={chooseCsv}
          onImport={importCsv}
          rows={importRows}
        />
      </div>
      {latest ? <LatestObservation value={latest} /> : null}
      <TrendTable points={trend} state={trendState} />
    </section>
  );
}

function FilterForm({
  filters,
  onSubmit,
  workspaces,
}: {
  readonly filters: VisibilityFilters;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly workspaces: readonly Workspace[];
}) {
  return (
    <form
      aria-label="可见性趋势筛选"
      className="rounded-2xl border border-line bg-white p-5 shadow-panel"
      key={JSON.stringify(filters)}
      onSubmit={onSubmit}
    >
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Select label="工作区" name="workspace_id" value={filters.workspaceId}>
          {workspaces.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </Select>
        <Input label="查询内容" name="query_text" value={filters.queryText ?? ''} />
        <Select label="平台" name="platform_code" value={filters.platformCode ?? ''}>
          <option value="">全部平台</option>
          {PLATFORMS.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </Select>
        <Input label="开始日期" name="from" type="date" value={filters.from} />
        <Input label="结束日期" name="to" type="date" value={filters.to} />
      </div>
      <button className={`${primary} mt-4`} type="submit">
        查看趋势
      </button>
    </form>
  );
}

function RecordForm({
  busy,
  onSubmit,
}: {
  readonly busy: boolean;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="rounded-2xl border border-line bg-white p-5 shadow-panel" onSubmit={onSubmit}>
      <h2 className="text-xl font-semibold">录入观察</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Input label="查询内容" name="query_text" required />
        <Select label="平台" name="platform_code" value="zhihu">
          {PLATFORMS.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </Select>
        <Input label="排名" min="1" name="rank_position" type="number" />
        <Input
          label="观察时间"
          name="observed_at"
          required
          type="datetime-local"
          value={localDateTime()}
        />
        <Input label="备注" name="notes" />
        <Input
          accept="image/jpeg,image/png,image/webp"
          label="证据截图"
          name="screenshot"
          type="file"
        />
      </div>
      <label className="mt-4 flex items-center gap-2 text-sm">
        <input name="is_cited" type="checkbox" /> 被引用
      </label>
      <button className={`${primary} mt-4`} disabled={busy} type="submit">
        录入
      </button>
    </form>
  );
}

function ImportPanel({
  busy,
  fileName,
  onChoose,
  onImport,
  rows,
}: {
  readonly busy: boolean;
  readonly fileName: string;
  readonly onChoose: (event: ChangeEvent<HTMLInputElement>) => void;
  readonly onImport: () => void;
  readonly rows: readonly VisibilityInput[];
}) {
  return (
    <section className="rounded-2xl border border-line bg-white p-5 shadow-panel">
      <h2 className="text-xl font-semibold">CSV 导入</h2>
      <p className="mt-2 text-sm text-ink-500">
        必需列：query_text、platform_code、rank_position、is_cited、observed_at；可选
        notes、evidence_asset_id。
      </p>
      <Input accept=".csv,text/csv" label="CSV 文件" name="csv" onChange={onChoose} type="file" />
      {rows.length ? (
        <div className="mt-4 overflow-x-auto">
          <p className="mb-2 text-sm">{fileName} · 前 5 行</p>
          <table className="min-w-[680px] text-sm">
            <thead>
              <tr>
                <th className="p-2">查询</th>
                <th className="p-2">平台</th>
                <th className="p-2">排名</th>
                <th className="p-2">引用</th>
                <th className="p-2">时间</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 5).map((row, index) => (
                <tr key={index}>
                  <td className="border-t p-2">{row.query_text}</td>
                  <td className="border-t p-2">{platformLabel(row.platform_code)}</td>
                  <td className="border-t p-2">{row.rank_position ?? '—'}</td>
                  <td className="border-t p-2">{row.is_cited ? '是' : '否'}</td>
                  <td className="border-t p-2">{row.observed_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <button
        className={`${secondary} mt-4`}
        disabled={busy || rows.length === 0}
        onClick={onImport}
        type="button"
      >
        导入
      </button>
    </section>
  );
}

function LatestObservation({ value }: { readonly value: Observation }) {
  return (
    <section className="rounded-2xl border border-line bg-white p-5 shadow-panel">
      <h2 className="text-xl font-semibold">最近录入</h2>
      <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="查询" value={value.query_text} />
        <Field label="平台" value={platformLabel(value.platform_code)} />
        <Field
          label="排名"
          value={value.rank_position === null ? '—' : String(value.rank_position)}
        />
        <Field label="引用" value={value.is_cited ? '是' : '否'} />
        <Field label="时间" value={value.observed_at} />
        <Field label="证据截图" value={value.evidence_asset_id ? '已保存' : '未上传'} />
      </dl>
    </section>
  );
}

function TrendTable({
  points,
  state,
}: {
  readonly points: readonly TrendPoint[];
  readonly state: 'loading' | 'ready' | 'error';
}) {
  if (state === 'loading') return <Panel title="正在加载趋势" text="正在聚合可见性观察。" />;
  if (state === 'error') return <Panel title="趋势加载失败" text="请检查筛选条件或服务状态。" />;
  if (points.length === 0) return <Panel title="暂无趋势数据" text="录入或导入观察后即可查看。" />;
  return (
    <section className="rounded-2xl border border-line bg-white p-5 shadow-panel">
      <h2 className="text-xl font-semibold">可见性趋势</h2>
      <div className="mt-4 overflow-x-auto">
        <table className="min-w-[920px] text-sm">
          <thead>
            <tr>
              <th className="p-2">日期</th>
              <th className="p-2">查询</th>
              <th className="p-2">平台</th>
              <th className="p-2">观察数</th>
              <th className="p-2">引用率</th>
              <th className="p-2">最佳排名</th>
              <th className="p-2">平均排名</th>
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={`${point.day}-${point.platform_code}-${point.query_hash}`}>
                <td className="border-t p-2">{point.day}</td>
                <td className="border-t p-2">{point.query_text}</td>
                <td className="border-t p-2">{platformLabel(point.platform_code)}</td>
                <td className="border-t p-2">{point.observation_count}</td>
                <td className="border-t p-2">{percent(point.citation_rate)}</td>
                <td className="border-t p-2">{point.best_rank ?? '—'}</td>
                <td className="border-t p-2">{point.average_rank ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Input({
  label,
  value,
  ...props
}: { readonly label: string; readonly value?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={labelClass}>
      {label}
      <input className={control} defaultValue={value} {...props} />
    </label>
  );
}

function platformLabel(code: string) {
  return PLATFORMS.find(([value]) => value === code)?.[1] ?? '其他平台';
}
function Select({
  children,
  label,
  name,
  value,
}: {
  readonly children: ReactNode;
  readonly label: string;
  readonly name: string;
  readonly value: string;
}) {
  return (
    <label className={labelClass}>
      {label}
      <select className={control} defaultValue={value} name={name}>
        {children}
      </select>
    </label>
  );
}
function Field({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className="mt-1 break-all text-sm">{value}</dd>
    </div>
  );
}
function Panel({ title, text }: { readonly title: string; readonly text: string }) {
  return (
    <section className="rounded-2xl border border-line bg-white p-8 text-center shadow-panel">
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="mt-3 text-sm text-ink-500">{text}</p>
    </section>
  );
}

function csvObservation(headers: readonly string[], row: readonly string[]): VisibilityInput {
  const value = (name: string) => row[headers.indexOf(name)]?.trim() ?? '';
  const query = value('query_text');
  const platform = value('platform_code') as Platform;
  const rank = value('rank_position');
  const cited = value('is_cited').toLowerCase();
  const observed = value('observed_at');
  const notes = value('notes');
  const evidence = value('evidence_asset_id');
  if (
    !query ||
    !PLATFORM_CODES.has(platform) ||
    (rank && (!/^\d+$/u.test(rank) || Number(rank) < 1)) ||
    !['true', 'false', '1', '0'].includes(cited) ||
    Number.isNaN(new Date(observed).getTime()) ||
    (evidence && !UUID.test(evidence))
  )
    throw new Error();
  return {
    ...(evidence ? { evidence_asset_id: evidence } : {}),
    is_cited: cited === 'true' || cited === '1',
    ...(notes ? { notes } : {}),
    observed_at: new Date(observed).toISOString(),
    platform_code: platform,
    query_text: query,
    ...(rank ? { rank_position: Number(rank) } : {}),
  };
}
function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index++;
      row.push(cell);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  if (quoted) throw new Error();
  row.push(cell);
  if (row.some(Boolean)) rows.push(row);
  return rows;
}
function readFilters(): VisibilityFilters {
  const dates = defaultDates();
  if (typeof window === 'undefined') return { ...dates, workspaceId: '' };
  const query = new URLSearchParams(location.search);
  const platform = query.get('platform_code');
  return {
    from: validDate(query.get('from')) ? query.get('from')! : dates.from,
    ...(platform && PLATFORM_CODES.has(platform as Platform)
      ? { platformCode: platform as Platform }
      : {}),
    ...(query.get('query_text')?.trim() ? { queryText: query.get('query_text')!.trim() } : {}),
    to: validDate(query.get('to')) ? query.get('to')! : dates.to,
    workspaceId: query.get('workspace_id') ?? '',
  };
}
function writeFilters(filters: VisibilityFilters) {
  const query = new URLSearchParams({
    from: filters.from,
    to: filters.to,
    workspace_id: filters.workspaceId,
  });
  if (filters.platformCode) query.set('platform_code', filters.platformCode);
  if (filters.queryText) query.set('query_text', filters.queryText);
  history.replaceState(null, '', `/anl-03?${query}`);
}
function defaultDates() {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 29);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}
function localDateTime() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
function validDate(value: string | null): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/u.test(value));
}
function cookie(name: string) {
  const prefix = `${name}=`;
  return (
    document.cookie
      .split(';')
      .map((item) => item.trim())
      .find((item) => item.startsWith(prefix))
      ?.slice(prefix.length) ?? ''
  );
}
function isAccess(error: unknown) {
  return error instanceof VisibilityRequestError && [401, 403, 404].includes(error.status);
}
function percent(value: number) {
  return new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 }).format(
    value,
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const labelClass = 'block text-sm text-ink-700';
const control = 'mt-2 block h-11 w-full rounded-control border border-line bg-white px-3 text-sm';
const primary =
  'h-11 rounded-control bg-brand-600 px-5 text-sm font-semibold text-white disabled:opacity-60';
const secondary =
  'h-11 rounded-control border border-line bg-white px-4 text-sm font-semibold disabled:opacity-60';
