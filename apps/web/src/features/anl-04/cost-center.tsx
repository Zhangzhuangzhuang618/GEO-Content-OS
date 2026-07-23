'use client';

import Link from 'next/link';
import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantChoice, TenantRole } from '../auth-02/tenant.schema';
import { modelLabel, skillLabel, TechnicalDetails } from '../human-readable';
import { listWorkspaces } from '../set-02/workspace-settings-api';
import type { Workspace } from '../set-02/workspace-settings.schema';
import {
  CostCenterRequestError,
  loadCostBudget,
  loadCostReport,
  reconcileProviderStatement,
} from './cost-center-api';
import type {
  CostBreakdownItem,
  CostBudget,
  CostFilters,
  CostReport,
  ProviderStatementLine,
  Reconciliation,
} from './cost-center.schema';

const ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'analyst']);
const STATEMENT_HEADERS = ['provider', 'currency', 'billed_cost_cents'];

export function CostCenter() {
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'empty' | 'permission'>(
    'loading',
  );
  const [filters, setFilters] = useState<CostFilters>(readFilters);
  const [tenant, setTenant] = useState<TenantChoice | null>(null);
  const [workspaces, setWorkspaces] = useState<readonly Workspace[]>([]);
  const [report, setReport] = useState<CostReport | null>(null);
  const [budget, setBudget] = useState<CostBudget | null>(null);
  const [budgetMonth, setBudgetMonth] = useState(readBudgetMonth);
  const [budgetState, setBudgetState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [statement, setStatement] = useState<readonly ProviderStatementLine[]>([]);
  const [statementName, setStatementName] = useState('');
  const [reconciliation, setReconciliation] = useState<Reconciliation | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const tenants = await listAvailableTenants(controller.signal);
        const active = tenants.find((item) => item.is_active);
        if (!active || !ROLES.has(active.role_code)) {
          setState('permission');
          return;
        }
        setTenant(active);
        const items = (await listWorkspaces(controller.signal)).filter(
          (item) => item.status === 'active',
        );
        setWorkspaces(items);
        if (items.length === 0) {
          setState('empty');
          return;
        }
        const workspaceId = items.some((item) => item.id === filters.workspaceId)
          ? filters.workspaceId
          : items[0]!.id;
        const next = { ...filters, workspaceId };
        setFilters(next);
        writeFilters(next, budgetMonth);
        await load(next, budgetMonth, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) setState(isAccess(error) ? 'permission' : 'error');
      }
    })();
    return () => controller.abort();
  }, []);

  async function load(next: CostFilters, month: string, signal?: AbortSignal) {
    setState('loading');
    setBudgetState('loading');
    try {
      const [costs, status] = await Promise.all([
        loadCostReport(next, signal),
        loadCostBudget(next.workspaceId, month, signal),
      ]);
      if (signal?.aborted) return;
      setReport(costs);
      setBudget(status);
      setBudgetState('ready');
      setState('ready');
    } catch (error) {
      if (signal?.aborted) return;
      setBudgetState('error');
      setState(isAccess(error) ? 'permission' : 'error');
    }
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = filtersFromForm(new FormData(event.currentTarget));
    setFilters(next);
    setReconciliation(null);
    writeFilters(next, budgetMonth);
    void load(next, budgetMonth);
  }

  async function refreshBudget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const month = String(new FormData(event.currentTarget).get('month') ?? '');
    setBudgetMonth(month);
    writeFilters(filters, month);
    setBudgetState('loading');
    try {
      setBudget(await loadCostBudget(filters.workspaceId, month));
      setBudgetState('ready');
    } catch (error) {
      setBudgetState('error');
      if (isAccess(error)) setState('permission');
    }
  }

  async function chooseStatement(event: ChangeEvent<HTMLInputElement>) {
    setStatement([]);
    setStatementName('');
    setReconciliation(null);
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    try {
      if (!file.name.toLowerCase().endsWith('.csv') || file.size > 1024 * 1024) throw new Error();
      const rows = parseCsv(await file.text());
      if (rows.length < 2 || rows.length > 501) throw new Error();
      const headers = rows[0]!.map((value, index) =>
        (index === 0 ? value.replace(/^\uFEFF/u, '') : value).trim(),
      );
      if (
        headers.length !== STATEMENT_HEADERS.length ||
        STATEMENT_HEADERS.some((header) => !headers.includes(header)) ||
        new Set(headers).size !== headers.length
      )
        throw new Error();
      const lines = rows.slice(1).map((row) => statementLine(headers, row));
      const keys = new Set(lines.map((line) => `${line.provider}\u0000${line.currency}`));
      if (keys.size !== lines.length) throw new Error();
      setStatement(lines);
      setStatementName(file.name);
      setMessage(`供应商账单校验通过，共 ${lines.length} 行。`);
    } catch {
      setMessage('账单 CSV 无法解析；请检查列、金额、唯一性、500 行和 1MB 限制。');
    }
  }

  async function reconcile() {
    if (statement.length === 0) return;
    const csrf = cookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪。');
      return;
    }
    setReconciling(true);
    setMessage(null);
    try {
      const result = await reconcileProviderStatement(filters, statement, csrf);
      setReconciliation(result);
      setMessage('账单已与已结算、未冲正的 usage ledger 完成对账。');
    } catch {
      setMessage('对账失败，请检查账单、筛选条件、权限或服务状态。');
    } finally {
      setReconciling(false);
    }
  }

  const breakdown = useMemo(
    () =>
      (report?.breakdown ?? []).filter(
        (item) =>
          (!filters.modelKey || item.model_key === filters.modelKey) &&
          (!filters.skillName || item.skill_name === filters.skillName),
      ),
    [filters.modelKey, filters.skillName, report],
  );

  function exportCsv() {
    if (!tenant || breakdown.length === 0) {
      setMessage('当前筛选范围没有可导出的成本明细。');
      return;
    }
    const rows = breakdown.map((item) => [
      tenant.id,
      item.workspace_id,
      item.project_id,
      item.package_id,
      item.variant_id,
      item.generation_run_id,
      item.cost_category,
      item.provider,
      item.model_key,
      item.skill_name,
      item.currency,
      item.cost_cents,
      item.entry_count,
    ]);
    downloadCsv(
      `cost-center-${filters.from}-${filters.to}.csv`,
      [
        'tenant_id',
        'workspace_id',
        'project_id',
        'package_id',
        'variant_id',
        'generation_run_id',
        'cost_category',
        'provider',
        'model_key',
        'skill_name',
        'currency',
        'cost_cents',
        'entry_count',
      ],
      rows,
    );
    setMessage(`已导出 ${rows.length} 行当前成本明细。`);
  }

  if (state === 'loading' && !report)
    return <Panel title="正在加载成本中心" text="正在读取权限、工作区和已结算 ledger。" />;
  if (state === 'permission')
    return <Panel title="无权访问成本中心" text="仅分析师、企业管理员和所有者可访问。" />;
  if (state === 'error')
    return <Panel title="无法加载成本中心" text="请检查筛选条件、网络、权限或服务状态。" />;
  if (state === 'empty') return <Panel title="暂无可用工作区" text="请先创建或启用工作区。" />;

  return (
    <section className="mt-8 space-y-5">
      <FilterPanel
        filters={filters}
        onExport={exportCsv}
        onSubmit={applyFilters}
        tenant={tenant}
        workspaces={workspaces}
      />
      <div aria-live="polite" className="min-h-6 text-sm text-ink-700">
        {message}
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <BudgetPanel
          budget={budget}
          month={budgetMonth}
          onSubmit={refreshBudget}
          state={budgetState}
          workspaceId={filters.workspaceId}
        />
        <StatementPanel
          fileName={statementName}
          lines={statement}
          onChoose={chooseStatement}
          onReconcile={reconcile}
          reconciling={reconciling}
        />
      </div>
      <CostTable items={breakdown} report={report} tenant={tenant} workspaces={workspaces} />
      {reconciliation ? <ReconciliationTable value={reconciliation} /> : null}
    </section>
  );
}

function FilterPanel({
  filters,
  onExport,
  onSubmit,
  tenant,
  workspaces,
}: {
  readonly filters: CostFilters;
  readonly onExport: () => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly tenant: TenantChoice | null;
  readonly workspaces: readonly Workspace[];
}) {
  return (
    <form
      aria-label="成本中心筛选"
      className="rounded-2xl border border-line bg-white p-5 shadow-panel"
      key={JSON.stringify(filters)}
      onSubmit={onSubmit}
    >
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Input disabled label="企业" name="tenant" value={tenant?.name ?? ''} />
        <Select label="工作区" name="workspace_id" value={filters.workspaceId}>
          {workspaces.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </Select>
        <Input
          label="币种"
          maxLength={3}
          name="currency"
          pattern="[A-Z]{3}"
          value={filters.currency ?? ''}
        />
        <Input label="开始日期" name="from" required type="date" value={filters.from} />
        <Input label="结束日期（不含）" name="to" required type="date" value={filters.to} />
      </div>
      <details className="mt-4 text-sm text-ink-600">
        <summary className="cursor-pointer font-medium">高级筛选</summary>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Input
            label="项目编号"
            name="project_id"
            pattern={UUID.source}
            value={filters.projectId ?? ''}
          />
          <Input
            label="内容任务编号"
            name="package_id"
            pattern={UUID.source}
            value={filters.packageId ?? ''}
          />
          <Input label="生成模型代码" name="model_key" value={filters.modelKey ?? ''} />
          <Input label="处理步骤代码" name="skill_name" value={filters.skillName ?? ''} />
        </div>
      </details>
      <div className="mt-4 flex flex-wrap gap-3">
        <button className={primary} type="submit">
          应用筛选
        </button>
        <button className={secondary} onClick={onExport} type="button">
          导出当前 CSV
        </button>
      </div>
    </form>
  );
}

function BudgetPanel({
  budget,
  month,
  onSubmit,
  state,
  workspaceId,
}: {
  readonly budget: CostBudget | null;
  readonly month: string;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly state: 'idle' | 'loading' | 'ready' | 'error';
  readonly workspaceId: string;
}) {
  return (
    <section className="rounded-2xl border border-line bg-white p-5 shadow-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">月度预算</h2>
          <p className="mt-2 text-sm text-ink-500">按工作区时区统计 CNY 已结算、未冲正成本。</p>
        </div>
        <Link className={smallLink} href={`/set-02?workspace_id=${workspaceId}`}>
          管理预算
        </Link>
      </div>
      <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={onSubmit}>
        <Input label="月份" name="month" required type="month" value={month} />
        <button className={secondary} type="submit">
          查看预算
        </button>
      </form>
      {state === 'loading' ? (
        <p className="mt-4 text-sm text-ink-500">正在计算预算…</p>
      ) : state === 'error' ? (
        <p className="mt-4 text-sm text-danger">预算加载失败。</p>
      ) : budget ? (
        <dl className="mt-5 grid gap-4 sm:grid-cols-3">
          <Kpi label="已用" value={money(budget.consumed_cents, budget.currency)} />
          <Kpi
            label="上限"
            value={
              budget.limit_cents === null ? '未设置' : money(budget.limit_cents, budget.currency)
            }
          />
          <Kpi
            label="剩余"
            value={
              budget.remaining_cents === null ? '—' : money(budget.remaining_cents, budget.currency)
            }
          />
          <Kpi label="硬限制" value={budget.hard_limit ? '启用' : '未启用'} />
          <Kpi
            label="状态"
            value={budget.is_exceeded ? '已超限' : budget.is_exhausted ? '已用尽' : '正常'}
          />
        </dl>
      ) : null}
    </section>
  );
}

function StatementPanel({
  fileName,
  lines,
  onChoose,
  onReconcile,
  reconciling,
}: {
  readonly fileName: string;
  readonly lines: readonly ProviderStatementLine[];
  readonly onChoose: (event: ChangeEvent<HTMLInputElement>) => void;
  readonly onReconcile: () => void;
  readonly reconciling: boolean;
}) {
  return (
    <section className="rounded-2xl border border-line bg-white p-5 shadow-panel">
      <h2 className="text-xl font-semibold">供应商账单对账</h2>
      <p className="mt-2 text-sm text-ink-500">
        上传供应商提供的 CSV 账单，与当前日期和工作区范围内的已结算成本核对。上传文件不会长期保存。
      </p>
      <Input
        accept=".csv,text/csv"
        label="供应商账单 CSV"
        name="statement"
        onChange={onChoose}
        type="file"
      />
      {lines.length > 0 ? (
        <p className="mt-3 text-sm">
          {fileName} · {lines.length} 行
        </p>
      ) : null}
      <button
        className={`${primary} mt-4`}
        disabled={reconciling || lines.length === 0}
        onClick={onReconcile}
        type="button"
      >
        {reconciling ? '正在对账…' : '与 ledger 对账'}
      </button>
    </section>
  );
}

function CostTable({
  items,
  report,
  tenant,
  workspaces,
}: {
  readonly items: readonly CostBreakdownItem[];
  readonly report: CostReport | null;
  readonly tenant: TenantChoice | null;
  readonly workspaces: readonly Workspace[];
}) {
  if (!report || items.length === 0)
    return <Panel title="暂无成本明细" text="当前筛选范围没有已结算且有效的成本记录。" />;
  const visibleTotals = aggregateTotals(items);
  return (
    <section className="rounded-2xl border border-line bg-white p-5 shadow-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">成本明细</h2>
          <p className="mt-2 text-sm text-ink-500">
            仅展示已结算的有效成本，退款或冲正记录已扣除。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {visibleTotals.map((total) => (
            <span className="rounded-full bg-surface-subtle px-3 py-1 text-sm" key={total.currency}>
              {money(total.cost_cents, total.currency)} · {total.entry_count} 条
            </span>
          ))}
        </div>
      </div>
      <div className="mt-5 overflow-x-auto">
        <table className="min-w-[980px] text-left text-sm">
          <thead className="bg-surface-subtle text-ink-500">
            <tr>
              {[
                '企业',
                '工作区',
                '处理步骤',
                '生成方式',
                '供应商',
                '类别',
                '金额',
                '条目',
                '更多',
              ].map((label) => (
                <th className="p-3" key={label}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <tr
                className="border-t border-line"
                key={`${item.workspace_id}-${item.project_id}-${item.package_id}-${item.model_key}-${item.skill_name}-${item.currency}-${index}`}
              >
                <td className="p-3">{tenant?.name ?? '—'}</td>
                <td className="p-3">
                  {workspaces.find(({ id }) => id === item.workspace_id)?.name ?? '全部工作区'}
                </td>
                <td className="p-3">{skillLabel(item.skill_name)}</td>
                <td className="p-3">{modelLabel(item.model_key)}</td>
                <td className="p-3">{item.provider ?? '未归属'}</td>
                <td className="p-3">{costCategoryLabel(item.cost_category)}</td>
                <td className="p-3 font-semibold">{money(item.cost_cents, item.currency)}</td>
                <td className="p-3">{item.entry_count}</td>
                <td className="p-3">
                  <TechnicalDetails>
                    <p>工作区：{item.workspace_id ?? '—'}</p>
                    <p>项目：{item.project_id ?? '—'}</p>
                    <p>内容任务：{item.package_id ?? '—'}</p>
                    <p>平台内容：{item.variant_id ?? '—'}</p>
                    <p>生成任务：{item.generation_run_id ?? '—'}</p>
                  </TechnicalDetails>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ReconciliationTable({ value }: { readonly value: Reconciliation }) {
  return (
    <section className="rounded-2xl border border-line bg-white p-5 shadow-panel">
      <h2 className="text-xl font-semibold">对账结果</h2>
      <p className="mt-2 text-sm text-ink-500">
        范围：{value.from} 至 {value.to} · 仅已结算
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="min-w-[780px] text-left text-sm">
          <thead className="bg-surface-subtle text-ink-500">
            <tr>
              <th className="p-3">供应商</th>
              <th className="p-3">币种</th>
              <th className="p-3">Ledger</th>
              <th className="p-3">账单</th>
              <th className="p-3">差额</th>
              <th className="p-3">状态</th>
            </tr>
          </thead>
          <tbody>
            {value.items.map((item, index) => (
              <tr
                className="border-t border-line"
                key={`${item.provider}-${item.currency}-${index}`}
              >
                <td className="p-3">{item.provider ?? '未归属'}</td>
                <td className="p-3">{item.currency}</td>
                <td className="p-3">{money(item.ledger_cost_cents, item.currency)}</td>
                <td className="p-3">
                  {item.billed_cost_cents === null
                    ? '—'
                    : money(item.billed_cost_cents, item.currency)}
                </td>
                <td className="p-3">
                  {item.delta_cents === null ? '—' : signedMoney(item.delta_cents, item.currency)}
                </td>
                <td className="p-3">{statusLabel(item.status)}</td>
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
function Kpi({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className="mt-1 text-base font-semibold">{value}</dd>
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

function filtersFromForm(data: FormData): CostFilters {
  const optional = (name: string) => String(data.get(name) ?? '').trim();
  return {
    ...(optional('currency') ? { currency: optional('currency').toUpperCase() } : {}),
    from: optional('from'),
    ...(optional('model_key') ? { modelKey: optional('model_key') } : {}),
    ...(optional('package_id') ? { packageId: optional('package_id') } : {}),
    ...(optional('project_id') ? { projectId: optional('project_id') } : {}),
    ...(optional('skill_name') ? { skillName: optional('skill_name') } : {}),
    to: optional('to'),
    workspaceId: optional('workspace_id'),
  };
}
function readFilters(): CostFilters {
  const dates = defaultDates();
  if (typeof window === 'undefined') return { ...dates, workspaceId: '' };
  const query = new URLSearchParams(location.search);
  const optional = (name: string) => query.get(name)?.trim() ?? '';
  return {
    ...(CURRENCY.test(optional('currency')) ? { currency: optional('currency') } : {}),
    from: validDate(optional('from')) ? optional('from') : dates.from,
    ...(optional('model_key') ? { modelKey: optional('model_key') } : {}),
    ...(UUID.test(optional('package_id')) ? { packageId: optional('package_id') } : {}),
    ...(UUID.test(optional('project_id')) ? { projectId: optional('project_id') } : {}),
    ...(optional('skill_name') ? { skillName: optional('skill_name') } : {}),
    to: validDate(optional('to')) ? optional('to') : dates.to,
    workspaceId: optional('workspace_id'),
  };
}
function readBudgetMonth() {
  if (typeof window === 'undefined') return new Date().toISOString().slice(0, 7);
  const value = new URLSearchParams(location.search).get('month');
  return value && MONTH.test(value) ? value : new Date().toISOString().slice(0, 7);
}
function writeFilters(filters: CostFilters, month: string) {
  const query = new URLSearchParams({
    from: filters.from,
    month,
    to: filters.to,
    workspace_id: filters.workspaceId,
  });
  if (filters.currency) query.set('currency', filters.currency);
  if (filters.modelKey) query.set('model_key', filters.modelKey);
  if (filters.packageId) query.set('package_id', filters.packageId);
  if (filters.projectId) query.set('project_id', filters.projectId);
  if (filters.skillName) query.set('skill_name', filters.skillName);
  history.replaceState(null, '', `/anl-04?${query}`);
}
function defaultDates() {
  const to = new Date();
  to.setUTCDate(to.getUTCDate() + 1);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 30);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}
function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value);
}
function statementLine(headers: readonly string[], row: readonly string[]): ProviderStatementLine {
  const value = (name: string) => row[headers.indexOf(name)]?.trim() ?? '';
  const provider = value('provider');
  const currency = value('currency').toUpperCase();
  const cents = value('billed_cost_cents');
  if (
    !provider ||
    provider.length > 80 ||
    !CURRENCY.test(currency) ||
    !/^\d+$/u.test(cents) ||
    !Number.isSafeInteger(Number(cents))
  )
    throw new Error();
  return { billed_cost_cents: Number(cents), currency, provider };
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
function downloadCsv(
  name: string,
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
) {
  const body = `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
  const url = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}
function csvCell(value: unknown) {
  const raw = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@\t\r]/u.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
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
  return error instanceof CostCenterRequestError && [401, 403, 404].includes(error.status);
}
function money(cents: number, currency: string) {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}
function aggregateTotals(items: readonly CostBreakdownItem[]) {
  const totals = new Map<string, { cost_cents: number; currency: string; entry_count: number }>();
  for (const item of items) {
    const total = totals.get(item.currency) ?? {
      cost_cents: 0,
      currency: item.currency,
      entry_count: 0,
    };
    total.cost_cents += item.cost_cents;
    total.entry_count += item.entry_count;
    totals.set(item.currency, total);
  }
  return [...totals.values()].sort((left, right) => left.currency.localeCompare(right.currency));
}
function signedMoney(cents: number, currency: string) {
  return `${cents > 0 ? '+' : ''}${money(cents, currency)}`;
}
function statusLabel(value: Reconciliation['items'][number]['status']) {
  return {
    matched: '一致',
    mismatch: '金额不一致',
    missing_ledger: 'Ledger 缺失',
    missing_statement: '账单缺失',
  }[value];
}

function costCategoryLabel(value: string): string {
  return (
    {
      generation: '内容生成',
      embedding: '资料理解',
      quality_check: '质量检查',
      publishing: '内容发布',
    }[value] ?? value.replaceAll('_', ' ')
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CURRENCY = /^[A-Z]{3}$/u;
const MONTH = /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/u;
const labelClass = 'block text-sm text-ink-700';
const control =
  'mt-2 block h-11 w-full rounded-control border border-line bg-white px-3 text-sm disabled:bg-surface-subtle';
const primary =
  'h-11 rounded-control bg-brand-600 px-5 text-sm font-semibold text-white disabled:opacity-60';
const secondary =
  'h-11 rounded-control border border-line bg-white px-4 text-sm font-semibold disabled:opacity-60';
const smallLink = 'rounded-control border border-line bg-white px-3 py-2 text-sm font-semibold';
