'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import { listProjects } from '../dash-01/dashboard-api';
import type { DashboardProject } from '../dash-01/dashboard.schema';
import { listWorkspaces } from '../set-02/workspace-settings-api';
import type { Workspace } from '../set-02/workspace-settings.schema';
import {
  AiVisibilityRequestError,
  createAiVisibilityQuerySet,
  createAiVisibilityRun,
  getAiVisibilityRun,
  listAiVisibilityQuerySets,
  listAiVisibilityRuns,
} from './ai-visibility-api';
import type {
  AiVisibilityIntent,
  AiVisibilityQuerySet,
  AiVisibilityRunDetail,
  AiVisibilityRunSummary,
} from './ai-visibility.schema';

const ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'analyst']);
const TERMINAL = new Set(['succeeded', 'partial', 'failed', 'cancelled']);
const INTENT_LABELS: Readonly<Record<AiVisibilityIntent, string>> = {
  brand_recognition: '品牌认知',
  comparison: '品牌比较',
  education: '用户科普',
  exploration: '需求探索',
  procurement: '采购决策',
  recommendation: '品牌推荐',
};

export function AiVisibilityLab() {
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error' | 'permission'>(
    'loading',
  );
  const [workspaces, setWorkspaces] = useState<readonly Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [projects, setProjects] = useState<readonly DashboardProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [querySets, setQuerySets] = useState<readonly AiVisibilityQuerySet[]>([]);
  const [querySetId, setQuerySetId] = useState('');
  const [runs, setRuns] = useState<readonly AiVisibilityRunSummary[]>([]);
  const [selectedRun, setSelectedRun] = useState<AiVisibilityRunSummary | null>(null);
  const [detail, setDetail] = useState<AiVisibilityRunDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void bootstrap(controller.signal);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!selectedRun || TERMINAL.has(selectedRun.status)) return;
    const controller = new AbortController();
    const poll = () => {
      void getAiVisibilityRun(selectedRun.workspace_id, selectedRun.id, controller.signal)
        .then((next) => {
          setSelectedRun(next);
          setDetail(next);
          if (TERMINAL.has(next.status)) void refreshRuns(next.query_set_id, next.id);
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setMessage('暂时无法刷新体检进度，系统会继续在后台执行。');
        });
    };
    const timer = window.setInterval(poll, 2_500);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [selectedRun?.id, selectedRun?.status, selectedRun?.updated_at]);

  async function bootstrap(signal?: AbortSignal) {
    try {
      const tenants = await listAvailableTenants(signal);
      const role = tenants.find((tenant) => tenant.is_active)?.role_code;
      if (!role || !ROLES.has(role)) return setState('permission');
      const available = (await listWorkspaces(signal)).filter((item) => item.status === 'active');
      setWorkspaces(available);
      if (available.length === 0) return setState('empty');
      const workspace = available[0]!.id;
      setWorkspaceId(workspace);
      const availableProjects = await listProjects(workspace, signal);
      setProjects(availableProjects);
      const project = availableProjects[0]?.id ?? '';
      setProjectId(project);
      setState('ready');
      if (project) await loadProject(workspace, project, signal);
    } catch (error) {
      if (!signal?.aborted) setState(isAccess(error) ? 'permission' : 'error');
    }
  }

  async function changeWorkspace(next: string) {
    setWorkspaceId(next);
    setProjectId('');
    setQuerySets([]);
    setRuns([]);
    setSelectedRun(null);
    setDetail(null);
    setBusy(true);
    try {
      const nextProjects = await listProjects(next);
      setProjects(nextProjects);
      const project = nextProjects[0]?.id ?? '';
      setProjectId(project);
      if (project) await loadProject(next, project);
    } catch {
      setMessage('无法读取该工作区的项目。');
    } finally {
      setBusy(false);
    }
  }

  async function changeProject(next: string) {
    setProjectId(next);
    setBusy(true);
    try {
      await loadProject(workspaceId, next);
    } catch {
      setMessage('无法读取该项目的 AI 可见度记录。');
    } finally {
      setBusy(false);
    }
  }

  async function loadProject(workspace: string, project: string, signal?: AbortSignal) {
    const sets = await listAiVisibilityQuerySets(workspace, project, signal);
    setQuerySets(sets);
    const selected = sets[0]?.id ?? '';
    setQuerySetId(selected);
    setRuns([]);
    setSelectedRun(null);
    setDetail(null);
    if (selected) await loadRuns(workspace, project, selected, signal);
  }

  async function selectQuerySet(next: string) {
    setQuerySetId(next);
    setBusy(true);
    try {
      await loadRuns(workspaceId, projectId, next);
    } catch {
      setMessage('无法读取该问题集的历史体检。');
    } finally {
      setBusy(false);
    }
  }

  async function loadRuns(workspace: string, project: string, setId: string, signal?: AbortSignal) {
    const items = await listAiVisibilityRuns(workspace, project, setId, signal);
    setRuns(items);
    const latest = items[0] ?? null;
    setSelectedRun(latest);
    if (latest) {
      const runDetail = await getAiVisibilityRun(workspace, latest.id, signal);
      setSelectedRun(runDetail);
      setDetail(runDetail);
    } else {
      setDetail(null);
    }
  }

  async function refreshRuns(setId: string, preferredRunId: string) {
    const items = await listAiVisibilityRuns(workspaceId, projectId, setId);
    setRuns(items);
    const preferred = items.find((item) => item.id === preferredRunId);
    if (preferred) setSelectedRun(preferred);
  }

  async function createQuerySet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectId) return setMessage('请先选择项目。');
    const csrf = cookie('geo_csrf');
    if (!csrf) return setMessage('登录安全令牌尚未就绪，请刷新页面。');
    const data = new FormData(event.currentTarget);
    const competitors = splitNames(String(data.get('competitors') ?? ''));
    if (competitors.length < 2) return setMessage('至少填写 2 个真实竞品，才能形成有意义的比较。');
    const brandName = String(data.get('brand_name') ?? '').trim();
    const industry = String(data.get('industry') ?? '').trim();
    const market = optional(data.get('market'));
    setBusy(true);
    setMessage('正在生成六类共 30 个基准问题…');
    try {
      const created = await createAiVisibilityQuerySet(
        {
          brandAliases: splitNames(String(data.get('brand_aliases') ?? '')),
          brandName,
          competitorNames: competitors,
          industry,
          market,
          name: `${market ? `${market} ` : ''}${industry} AI 可见度基准`,
          positioning: optional(data.get('positioning')),
          projectId,
          workspaceId,
        },
        csrf,
      );
      setQuerySets((current) => [created, ...current]);
      setQuerySetId(created.id);
      setRuns([]);
      setSelectedRun(null);
      setDetail(null);
      setMessage('问题集已生成。请先浏览问题，再开始 AI 体检。');
    } catch {
      setMessage('问题集创建失败，请检查项目权限和填写内容。');
    } finally {
      setBusy(false);
    }
  }

  async function startRun() {
    const csrf = cookie('geo_csrf');
    if (!csrf || !querySetId) return setMessage('登录安全令牌尚未就绪，请刷新页面。');
    const baseline =
      selectedRun && ['succeeded', 'partial'].includes(selectedRun.status) ? selectedRun.id : null;
    setBusy(true);
    setMessage(baseline ? '正在启动复测，完成后会与本次结果比较…' : '正在启动 30 问 AI 体检…');
    try {
      const run = await createAiVisibilityRun(workspaceId, querySetId, baseline, csrf);
      setRuns((current) => [run, ...current]);
      setSelectedRun(run);
      setDetail(null);
      setMessage('体检已进入后台队列。页面会自动刷新进度。');
    } catch (error) {
      setMessage(
        error instanceof AiVisibilityRequestError && error.status === 409
          ? '相同请求已在处理中，请等待当前体检完成。'
          : '无法启动体检，请确认 AI Worker 和 DeepSeek 配置正常。',
      );
    } finally {
      setBusy(false);
    }
  }

  async function openRun(run: AiVisibilityRunSummary) {
    setSelectedRun(run);
    setBusy(true);
    try {
      setDetail(await getAiVisibilityRun(workspaceId, run.id));
    } catch {
      setMessage('无法加载本次体检详情。');
    } finally {
      setBusy(false);
    }
  }

  const selectedQuerySet = querySets.find((item) => item.id === querySetId) ?? null;
  const baseline = selectedRun?.baseline_run_id
    ? (runs.find((item) => item.id === selectedRun.baseline_run_id) ?? null)
    : null;

  if (state === 'loading')
    return <Panel title="正在加载 AI 可见度体检" text="正在读取企业、工作区和项目。" />;
  if (state === 'permission')
    return <Panel title="无权使用 AI 可见度体检" text="仅分析师、企业管理员和所有者可使用。" />;
  if (state === 'error')
    return <Panel title="无法加载 AI 可见度体检" text="请检查网络、登录状态和 API 服务。" />;
  if (state === 'empty') return <Panel title="暂无可用工作区" text="请先创建或启用工作区。" />;

  return (
    <section className="mt-8 space-y-5">
      <div className="rounded-2xl border border-brand-200 bg-brand-50 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-brand-700">AI 可见度体检</p>
            <h2 className="mt-1 text-2xl font-semibold text-ink-950">
              看 AI 会不会主动提到你的品牌
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-ink-600">
              系统用六类真实用户问题调用
              DeepSeek，保留每一道原始回答，并比较品牌提及、认知、排名、推荐、竞品和来源。
            </p>
          </div>
          <ol
            className="flex flex-wrap gap-2 text-xs font-medium text-ink-600"
            aria-label="AI 可见度体检步骤"
          >
            {['设置品牌与竞品', '确认 30 个问题', '运行 AI 体检', '按缺口创建内容'].map(
              (step, index) => (
                <li className="rounded-full bg-white px-3 py-2" key={step}>
                  {index + 1}. {step}
                </li>
              ),
            )}
          </ol>
        </div>
        <p className="mt-4 rounded-xl bg-white/80 px-4 py-3 text-xs leading-5 text-ink-600">
          当前是“模型记忆测试”，不是联网搜索监测。结果适合做同一问题集的前后对比，不代表全网绝对排名。
        </p>
      </div>

      <ScopeCard
        busy={busy}
        onProjectChange={(value) => void changeProject(value)}
        onWorkspaceChange={(value) => void changeWorkspace(value)}
        projectId={projectId}
        projects={projects}
        workspaceId={workspaceId}
        workspaces={workspaces}
      />

      {message ? (
        <div
          aria-live="polite"
          className="rounded-xl border border-line bg-white px-4 py-3 text-sm text-ink-700"
        >
          {message}
        </div>
      ) : null}

      {!projectId ? (
        <Panel title="当前工作区还没有项目" text="请先在设置中创建项目，再进行品牌可见度体检。" />
      ) : querySets.length === 0 ? (
        <QuerySetForm busy={busy} onSubmit={createQuerySet} />
      ) : (
        <>
          <QuerySetCard
            busy={busy}
            onCreateNew={() => setQuerySets([])}
            onSelect={(value) => void selectQuerySet(value)}
            querySet={selectedQuerySet}
            querySetId={querySetId}
            querySets={querySets}
          />
          <RunCard
            busy={busy}
            onOpen={(run) => void openRun(run)}
            onStart={() => void startRun()}
            runs={runs}
            selectedRun={selectedRun}
          />
          {selectedRun ? (
            <Report baseline={baseline} detail={detail} projectId={projectId} run={selectedRun} />
          ) : null}
        </>
      )}
    </section>
  );
}

function ScopeCard(props: {
  readonly busy: boolean;
  readonly onProjectChange: (value: string) => void;
  readonly onWorkspaceChange: (value: string) => void;
  readonly projectId: string;
  readonly projects: readonly DashboardProject[];
  readonly workspaceId: string;
  readonly workspaces: readonly Workspace[];
}) {
  return (
    <div className="grid gap-4 rounded-2xl border border-line bg-white p-5 shadow-panel sm:grid-cols-2">
      <Select
        label="分析工作区"
        disabled={props.busy}
        value={props.workspaceId}
        onChange={props.onWorkspaceChange}
      >
        {props.workspaces.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </Select>
      <Select
        label="分析项目"
        disabled={props.busy}
        value={props.projectId}
        onChange={props.onProjectChange}
      >
        {props.projects.length === 0 ? <option value="">暂无项目</option> : null}
        {props.projects.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </Select>
    </div>
  );
}

function QuerySetForm({
  busy,
  onSubmit,
}: {
  readonly busy: boolean;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="rounded-2xl border border-line bg-white p-6 shadow-panel" onSubmit={onSubmit}>
      <div>
        <p className="text-xs font-semibold text-brand-700">第 1 步</p>
        <h2 className="mt-1 text-xl font-semibold text-ink-950">告诉系统要测谁、和谁比较</h2>
        <p className="mt-2 text-sm text-ink-500">
          系统会确定性生成六类共 30 个问题，你可以在运行前完整查看。
        </p>
      </div>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Input label="品牌名称" name="brand_name" placeholder="例如：志远搬家" required />
        <Input label="所属行业" name="industry" placeholder="例如：搬家服务" required />
        <Input label="主要市场" name="market" placeholder="例如：广州（可选）" />
        <Input label="品牌别名" name="brand_aliases" placeholder="逗号分隔，例如：广州志远搬家" />
        <label className="sm:col-span-2 text-sm font-medium text-ink-700">
          真实竞品 <span className="font-normal text-ink-500">至少 2 个，逗号或换行分隔</span>
          <textarea
            className={textarea}
            name="competitors"
            placeholder="例如：竞品甲，竞品乙"
            required
          />
        </label>
        <label className="sm:col-span-2 text-sm font-medium text-ink-700">
          品牌定位 <span className="font-normal text-ink-500">可选</span>
          <textarea
            className={textarea}
            name="positioning"
            placeholder="例如：正规自有团队、稳定履约"
          />
        </label>
      </div>
      <button className={`${primary} mt-5`} disabled={busy} type="submit">
        生成 30 个测试问题
      </button>
    </form>
  );
}

function QuerySetCard(props: {
  readonly busy: boolean;
  readonly onCreateNew: () => void;
  readonly onSelect: (value: string) => void;
  readonly querySet: AiVisibilityQuerySet | null;
  readonly querySetId: string;
  readonly querySets: readonly AiVisibilityQuerySet[];
}) {
  const grouped = useMemo(() => {
    const result = new Map<AiVisibilityIntent, AiVisibilityQuerySet['queries']>();
    for (const query of props.querySet?.queries ?? []) {
      result.set(query.intent_code, [...(result.get(query.intent_code) ?? []), query]);
    }
    return result;
  }, [props.querySet]);
  return (
    <div className="rounded-2xl border border-line bg-white p-6 shadow-panel">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold text-brand-700">第 2 步</p>
          <h2 className="mt-1 text-xl font-semibold text-ink-950">确认基准问题</h2>
          <p className="mt-2 text-sm text-ink-500">问题集一旦运行就保持不变，复测才有可比性。</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label="问题集"
            disabled={props.busy}
            value={props.querySetId}
            onChange={props.onSelect}
          >
            {props.querySets.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · 第 {item.revision} 版
              </option>
            ))}
          </Select>
          <button className={secondary} onClick={props.onCreateNew} type="button">
            新建另一套
          </button>
        </div>
      </div>
      {props.querySet ? (
        <div className="mt-5">
          <div className="flex flex-wrap gap-2 text-xs text-ink-600">
            <span className="rounded-full bg-surface-subtle px-3 py-1.5">
              品牌：{props.querySet.brand_name}
            </span>
            <span className="rounded-full bg-surface-subtle px-3 py-1.5">
              行业：{props.querySet.industry}
            </span>
            <span className="rounded-full bg-surface-subtle px-3 py-1.5">
              竞品：{props.querySet.competitor_names.join('、')}
            </span>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {[...grouped.entries()].map(([intent, queries]) => (
              <details className="rounded-xl border border-line p-4" key={intent}>
                <summary className="cursor-pointer font-semibold text-ink-800">
                  {INTENT_LABELS[intent]} · {queries.length} 问
                </summary>
                <ol className="mt-3 space-y-2 text-sm leading-6 text-ink-600">
                  {queries.map((query) => (
                    <li key={query.id}>
                      {query.sort_order}. {query.query_text}
                    </li>
                  ))}
                </ol>
              </details>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RunCard(props: {
  readonly busy: boolean;
  readonly onOpen: (run: AiVisibilityRunSummary) => void;
  readonly onStart: () => void;
  readonly runs: readonly AiVisibilityRunSummary[];
  readonly selectedRun: AiVisibilityRunSummary | null;
}) {
  const active = props.selectedRun && !TERMINAL.has(props.selectedRun.status);
  const hasBaseline =
    props.selectedRun && ['succeeded', 'partial'].includes(props.selectedRun.status);
  return (
    <div className="rounded-2xl border border-line bg-white p-6 shadow-panel">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold text-brand-700">第 3 步</p>
          <h2 className="mt-1 text-xl font-semibold text-ink-950">运行 AI 体检</h2>
          <p className="mt-2 text-sm text-ink-500">
            每次调用 30 道问题；复测会自动绑定上一次结果用于比较。
          </p>
        </div>
        <button
          className={primary}
          disabled={props.busy || Boolean(active)}
          onClick={props.onStart}
          type="button"
        >
          {active ? '体检进行中…' : hasBaseline ? '按相同问题复测' : '开始 30 问体检'}
        </button>
      </div>
      {props.runs.length > 0 ? (
        <div className="mt-5 flex flex-wrap gap-2">
          {props.runs.map((run, index) => (
            <button
              className={`rounded-full border px-3 py-2 text-xs ${props.selectedRun?.id === run.id ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-line text-ink-600'}`}
              key={run.id}
              onClick={() => props.onOpen(run)}
              type="button"
            >
              {index === 0 ? '最新 · ' : ''}
              {formatTime(run.created_at)} · {statusLabel(run.status)}
              {run.score === null ? '' : ` · ${run.score}分`}
            </button>
          ))}
        </div>
      ) : (
        <p className="mt-5 text-sm text-ink-500">还没有体检记录。</p>
      )}
    </div>
  );
}

function Report(props: {
  readonly baseline: AiVisibilityRunSummary | null;
  readonly detail: AiVisibilityRunDetail | null;
  readonly projectId: string;
  readonly run: AiVisibilityRunSummary;
}) {
  const run = props.detail ?? props.run;
  if (!TERMINAL.has(run.status)) {
    const processed = run.completed_count + run.failed_count;
    return (
      <div className="rounded-2xl border border-line bg-white p-6 shadow-panel">
        <h2 className="text-xl font-semibold text-ink-950">体检正在进行</h2>
        <p className="mt-2 text-sm text-ink-500">
          已处理 {processed}/{run.query_count} 道问题。离开页面不会中断任务。
        </p>
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-surface-subtle">
          <div
            className="h-full bg-brand-600 transition-all"
            style={{ width: `${Math.round((processed / run.query_count) * 100)}%` }}
          />
        </div>
      </div>
    );
  }
  if (run.status === 'failed' || !run.metrics) {
    return (
      <Panel
        title="本次体检没有形成有效报告"
        text="所有问题都调用失败。请检查 AI Worker、DeepSeek 密钥和模型配置后重新运行。"
      />
    );
  }
  const delta =
    props.baseline?.score === null || props.baseline?.score === undefined || run.score === null
      ? null
      : run.score - props.baseline.score;
  const domainSources = run.sources.filter((source) => source.level === 'domain');
  const urlSources = run.sources.filter(
    (source): source is typeof source & { readonly url: string } =>
      source.level === 'url' && source.url !== null,
  );
  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-line bg-white p-6 shadow-panel">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <h2 className="text-xs font-semibold text-brand-700">体检结果</h2>
            <div className="mt-2 flex items-end gap-3">
              <strong className="text-5xl tracking-tight text-ink-950">{run.score}</strong>
              <span className="pb-1 text-sm text-ink-500">/ 100</span>
            </div>
            <p className="mt-2 text-xs text-ink-500">
              内部基准分 · {run.scoring_version}
              {delta === null ? '' : ` · 较基准 ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} 分`}
            </p>
          </div>
          <div className="grid min-w-[60%] flex-1 grid-cols-2 gap-3 sm:grid-cols-3">
            <Metric label="自然提及率" value={percent(run.metrics.mention_rate)} />
            <Metric label="品牌认知率" value={percent(run.metrics.recognition_rate)} />
            <Metric
              label="明确排名均值"
              value={run.metrics.average_rank?.toFixed(2) ?? '未形成排名'}
            />
            <Metric label="正向情感率" value={percent(run.metrics.positive_sentiment_rate)} />
            <Metric label="推荐率" value={percent(run.metrics.recommendation_rate)} />
            <Metric
              label="有效回答"
              value={`${run.metrics.answered_count}/${run.metrics.total_count}`}
            />
          </div>
        </div>
        {run.status === 'partial' ? (
          <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
            有 {run.failed_count} 道问题调用失败，本报告只按成功回答计算。
          </p>
        ) : null}
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <div className="rounded-2xl border border-line bg-white p-6 shadow-panel">
          <h3 className="text-lg font-semibold text-ink-950">竞品被提到多少次</h3>
          <div className="mt-4 space-y-4">
            {run.competitors.map((item) => (
              <div key={item.name}>
                <div className="flex justify-between text-sm">
                  <span>{item.name}</span>
                  <span>
                    {item.mention_count} 次 · {percent(item.mention_rate)}
                  </span>
                </div>
                <div className="mt-2 h-2 rounded-full bg-surface-subtle">
                  <div
                    className="h-2 rounded-full bg-ink-400"
                    style={{ width: percent(item.mention_rate) }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-2xl border border-line bg-white p-6 shadow-panel">
          <h3 className="text-lg font-semibold text-ink-950">回答引用了哪些来源</h3>
          <p className="mt-1 text-xs text-ink-500">
            仅统计模型原文中明确出现的链接，不代表系统已验证其真实性。
          </p>
          <div className="mt-4 space-y-5 text-sm">
            {run.sources.length === 0 ? (
              <p className="text-ink-500">本次回答没有出现可核验网址。</p>
            ) : (
              <>
                <div>
                  <p className="font-medium text-ink-800">常见来源网站</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {domainSources.map((source) => (
                      <span
                        className="rounded-full bg-surface-subtle px-3 py-1.5 text-ink-700"
                        key={`domain:${source.domain}`}
                      >
                        {source.domain} · {source.mention_count} 次 / {source.query_count} 问
                      </span>
                    ))}
                  </div>
                </div>
                {urlSources.length > 0 ? (
                  <div>
                    <p className="font-medium text-ink-800">具体页面</p>
                    <div className="mt-2 space-y-2">
                      {urlSources.map((source) => (
                        <a
                          className="block break-all text-brand-700 hover:underline"
                          href={source.url}
                          key={source.url}
                          rel="noreferrer"
                          target="_blank"
                        >
                          {source.url} · {source.mention_count} 次
                        </a>
                      ))}
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-line bg-white p-6 shadow-panel">
        <p className="text-xs font-semibold text-brand-700">第 4 步</p>
        <h3 className="mt-1 text-xl font-semibold text-ink-950">优先补齐这些内容缺口</h3>
        <p className="mt-2 text-sm text-ink-500">
          以下高价值问题提到了竞品、但没有自然提到你的品牌。点击后会把问题带入现有创建内容流程，仍执行原有质量检查与发布流程。
        </p>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {run.opportunities.length === 0 ? (
            <p className="text-sm text-ink-500">本次没有发现高价值零命中问题。</p>
          ) : (
            run.opportunities.map((item) => (
              <div className="rounded-xl border border-line p-4" key={item.query_id}>
                <p className="text-xs font-medium text-ink-500">
                  {INTENT_LABELS[item.intent_code]}
                  {item.competitors_mentioned.length
                    ? ` · 提到 ${item.competitors_mentioned.join('、')}`
                    : ''}
                </p>
                <p className="mt-2 font-medium leading-6 text-ink-900">{item.query_text}</p>
                <Link
                  className="mt-3 inline-flex text-sm font-semibold text-brand-700"
                  href={`/dash-01?project_id=${props.projectId}&topic=${encodeURIComponent(item.query_text)}`}
                >
                  用这个问题创建内容 →
                </Link>
              </div>
            ))
          )}
        </div>
      </div>

      {props.detail ? (
        <div className="rounded-2xl border border-line bg-white p-6 shadow-panel">
          <h3 className="text-xl font-semibold text-ink-950">逐题原始回答</h3>
          <p className="mt-2 text-sm text-ink-500">
            每一道问题和模型原文都保留，可直接核对分数为何这样计算。
          </p>
          <div className="mt-4 space-y-3">
            {props.detail.responses.map((response) => (
              <details className="rounded-xl border border-line p-4" key={response.id}>
                <summary className="cursor-pointer list-none">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="font-medium text-ink-900">
                      {response.query.sort_order}. {response.query.query_text}
                    </span>
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs ${response.target_mentioned ? 'bg-emerald-50 text-emerald-700' : 'bg-surface-subtle text-ink-500'}`}
                    >
                      {response.query.intent_code === 'brand_recognition'
                        ? recognitionLabel(response.recognition_status)
                        : response.target_mentioned
                          ? `自然提到品牌${response.target_rank ? ` · 明确第 ${response.target_rank} 位` : ''}`
                          : '未自然提到品牌'}
                    </span>
                  </div>
                </summary>
                <div className="mt-4 whitespace-pre-wrap border-t border-line pt-4 text-sm leading-7 text-ink-700">
                  {response.answer_text ??
                    `调用失败：${String(response.error_json?.['message'] ?? '未知错误')}`}
                </div>
              </details>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-xl bg-surface-subtle p-4">
      <p className="text-xs text-ink-500">{label}</p>
      <p className="mt-1 text-xl font-semibold text-ink-950">{value}</p>
    </div>
  );
}

function Input(props: {
  readonly label: string;
  readonly name: string;
  readonly placeholder?: string;
  readonly required?: boolean;
}) {
  return (
    <label className="text-sm font-medium text-ink-700">
      {props.label}
      <input
        className={input}
        name={props.name}
        placeholder={props.placeholder}
        required={props.required}
      />
    </label>
  );
}

function Select(props: {
  readonly children: React.ReactNode;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly value: string;
}) {
  return (
    <label className="min-w-56 text-sm font-medium text-ink-700">
      {props.label}
      <select
        className={input}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
        value={props.value}
      >
        {props.children}
      </select>
    </label>
  );
}

function Panel({ title, text }: { readonly title: string; readonly text: string }) {
  return (
    <section className="mt-8 rounded-2xl border border-line bg-white p-8 text-center shadow-panel">
      <h2 className="text-xl font-semibold text-ink-950">{title}</h2>
      <p className="mt-2 text-sm text-ink-500">{text}</p>
    </section>
  );
}

function splitNames(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[，,\n]/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function optional(value: FormDataEntryValue | null): string | null {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function cookie(name: string): string | null {
  const prefix = `${name}=`;
  const found = document.cookie
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix));
  return found ? decodeURIComponent(found.slice(prefix.length)) : null;
}

function isAccess(error: unknown): boolean {
  return error instanceof AiVisibilityRequestError && [401, 403].includes(error.status);
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: '2-digit',
  }).format(new Date(value));
}

function statusLabel(status: AiVisibilityRunSummary['status']): string {
  return (
    {
      cancelled: '已取消',
      failed: '失败',
      partial: '部分完成',
      queued: '排队中',
      running: '进行中',
      succeeded: '已完成',
    } as const
  )[status];
}

function recognitionLabel(
  status: AiVisibilityRunDetail['responses'][number]['recognition_status'],
): string {
  return (
    {
      misidentified: '疑似误认品牌',
      not_applicable: '不适用认知判断',
      not_recognized: '未识别品牌',
      recognized: '正确识别品牌',
      uncertain: '识别结果不确定',
    } as const
  )[status];
}

const input =
  'mt-2 h-11 w-full rounded-xl border border-line bg-white px-3 text-sm text-ink-950 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-100';
const textarea =
  'mt-2 min-h-24 w-full rounded-xl border border-line bg-white px-3 py-3 text-sm text-ink-950 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-100';
const primary =
  'inline-flex min-h-11 items-center justify-center rounded-xl bg-brand-600 px-5 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50';
const secondary =
  'inline-flex min-h-11 items-center justify-center rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-700 hover:bg-surface-subtle';
