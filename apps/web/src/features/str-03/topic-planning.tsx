'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import { listProjects } from '../know-02/source-upload-api';
import type { ProjectChoice } from '../know-02/source-upload.schema';
import { listActiveWorkspaces } from '../str-02/brand-profile-api';
import { listKeywordSets } from '../str-04/keyword-set-api';
import type { KeywordSet } from '../str-04/keyword-set.schema';
import {
  adoptTopicCandidate,
  generateTopicPlan,
  listTopicCandidates,
  TopicPlanningRequestError,
} from './topic-planning-api';
import {
  PlatformCodeSchema,
  TopicRiskSchema,
  TopicStatusSchema,
  type PlatformCode,
  type TopicCandidate,
  type TopicFilters,
  type TopicRisk,
  type TopicStatus,
} from './topic-planning.schema';

const MANAGER_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'strategy_editor']);
const PLATFORM_OPTIONS = [
  ['official_website', '官网'],
  ['baijiahao', '百家号'],
  ['toutiao', '头条号'],
  ['zhihu', '知乎'],
  ['xiaohongshu', '小红书'],
  ['wechat_official', '微信公众号'],
  ['douyin', '抖音'],
] as const satisfies readonly (readonly [PlatformCode, string])[];

export function TopicPlanning() {
  const [filters, setFilters] = useState<TopicFilters>(readFilters);
  const [items, setItems] = useState<TopicCandidate[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [role, setRole] = useState<TenantRole | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'permission'>('loading');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(
    async (
      nextFilters: TopicFilters & { cursor?: string },
      append = false,
      signal?: AbortSignal,
    ) => {
      setState('loading');
      try {
        const [tenants, page] = await Promise.all([
          listAvailableTenants(signal),
          listTopicCandidates(nextFilters, signal),
        ]);
        if (signal?.aborted) return;
        setRole(tenants.find((tenant) => tenant.is_active)?.role_code ?? null);
        setItems((current) => (append ? [...current, ...page.items] : page.items));
        setNextCursor(page.nextCursor);
        setState('ready');
      } catch (error) {
        if (signal?.aborted) return;
        setState(
          error instanceof TopicPlanningRequestError && error.status === 403
            ? 'permission'
            : 'error',
        );
      }
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(filters, false, controller.signal);
    return () => controller.abort();
  }, [filters, load]);

  function updateFilter(name: keyof TopicFilters, value: string) {
    const next: TopicFilters = { ...filters };
    if (value) Object.assign(next, { [name]: value });
    else delete next[name];
    setFilters(next);
    const query = new URLSearchParams();
    if (next.platformCode) query.set('platform_code', next.platformCode);
    if (next.riskLevel) query.set('risk_level', next.riskLevel);
    if (next.status) query.set('status', next.status);
    window.history.replaceState(null, '', query.size ? `/str-03?${query}` : '/str-03');
  }

  async function adopt(topic: TopicCandidate) {
    if (topic.evidence_ids.length === 0 || topic.status !== 'proposed') return;
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    setBusyId(topic.id);
    setMessage(null);
    try {
      const briefTitle = await adoptTopicCandidate(topic, csrf);
      setItems((current) =>
        current.map((item) => (item.id === topic.id ? { ...item, status: 'adopted' } : item)),
      );
      setMessage(`已采纳为内容需求：${briefTitle}`);
    } catch {
      setMessage('采纳失败，选题版本可能已变化，请刷新后重试。');
    } finally {
      setBusyId(null);
    }
  }

  if (state === 'permission')
    return <StatePanel title="无权查看选题" text="当前工作区权限不允许访问策略中心。" />;
  if (state === 'error') return <StatePanel title="无法加载选题" text="请检查网络后刷新页面。" />;

  const canManage = role !== null && MANAGER_ROLES.has(role);
  return (
    <section className="mt-8">
      {canManage ? <GeneratePanel onMessage={setMessage} /> : null}
      <div className="mt-5 rounded-2xl border border-line bg-white p-4 shadow-panel">
        <div className="grid gap-3 sm:grid-cols-3">
          <Filter
            label="平台"
            onChange={(value) => updateFilter('platformCode', value)}
            options={PLATFORM_OPTIONS}
            value={filters.platformCode}
          />
          <Filter
            label="风险"
            onChange={(value) => updateFilter('riskLevel', value)}
            options={[
              ['low', '低'],
              ['medium', '中'],
              ['high', '高'],
              ['critical', '严重'],
            ]}
            value={filters.riskLevel}
          />
          <Filter
            label="状态"
            onChange={(value) => updateFilter('status', value)}
            options={[
              ['proposed', '待采纳'],
              ['adopted', '已采纳'],
              ['archived', '已归档'],
            ]}
            value={filters.status}
          />
        </div>
      </div>

      {state === 'loading' && items.length === 0 ? (
        <ListSkeleton />
      ) : items.length === 0 ? (
        <StatePanel title="暂无选题" text="当前筛选条件下没有候选选题。" />
      ) : (
        <ul className="mt-5 grid gap-4" aria-label="候选选题列表">
          {items.map((topic) => (
            <TopicCard
              busy={busyId === topic.id}
              canManage={canManage}
              key={topic.id}
              onAdopt={adopt}
              topic={topic}
            />
          ))}
        </ul>
      )}
      <div aria-live="polite" className="mt-4 min-h-10">
        {message ? (
          <p className="rounded-control bg-brand-50 px-3 py-2 text-sm text-brand-700" role="status">
            {message}
          </p>
        ) : null}
      </div>
      {nextCursor ? (
        <button
          className={secondaryButton}
          disabled={state === 'loading'}
          onClick={() => void load({ ...filters, cursor: nextCursor }, true)}
          type="button"
        >
          加载更多
        </button>
      ) : null}
    </section>
  );
}

function GeneratePanel({ onMessage }: { onMessage: (message: string | null) => void }) {
  const [submitting, setSubmitting] = useState(false);
  const [workspaces, setWorkspaces] = useState<readonly { id: string; name: string }[]>([]);
  const [projects, setProjects] = useState<readonly ProjectChoice[]>([]);
  const [keywordSets, setKeywordSets] = useState<readonly KeywordSet[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [projectId, setProjectId] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    void listActiveWorkspaces(controller.signal)
      .then(setWorkspaces)
      .catch(() => {
        if (!controller.signal.aborted) onMessage('无法加载工作区，请稍后重试。');
      });
    return () => controller.abort();
  }, [onMessage]);

  useEffect(() => {
    if (!workspaceId) {
      setProjects([]);
      return;
    }
    const controller = new AbortController();
    void listProjects(workspaceId, controller.signal)
      .then(setProjects)
      .catch(() => {
        if (!controller.signal.aborted) onMessage('无法加载项目，请稍后重试。');
      });
    return () => controller.abort();
  }, [onMessage, workspaceId]);

  useEffect(() => {
    if (!projectId) {
      setKeywordSets([]);
      return;
    }
    const controller = new AbortController();
    void listKeywordSets({ projectId, status: 'active' }, controller.signal)
      .then(setKeywordSets)
      .catch(() => {
        if (!controller.signal.aborted) onMessage('无法加载关键词集，请稍后重试。');
      });
    return () => controller.abort();
  }, [onMessage, projectId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const workspaceId = String(data.get('workspace_id') ?? '').trim();
    const projectId = String(data.get('project_id') ?? '').trim();
    const keywordSetIds = data.getAll('keyword_set_ids').map(String);
    const platformCodes = data.getAll('platform_codes').map(String).filter(isPlatformCode);
    if (!isUuid(workspaceId) || !isUuid(projectId) || keywordSetIds.some((id) => !isUuid(id))) {
      onMessage('请选择工作区、项目和关键词集。');
      return;
    }
    if (keywordSetIds.length === 0 || platformCodes.length === 0) {
      onMessage('至少选择一个关键词集和一个目标平台。');
      return;
    }
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      onMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    setSubmitting(true);
    onMessage(null);
    try {
      await generateTopicPlan(
        {
          keywordSetIds,
          maxTopics: Number(data.get('max_topics')),
          platformCodes,
          projectId,
          seedQueries: splitValues(String(data.get('seed_queries') ?? '')),
          workspaceId,
        },
        csrf,
      );
      onMessage('选题生成已开始，完成后会出现在下方列表中。');
    } catch {
      onMessage('选题生成任务创建失败，请检查输入或稍后重试。');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="rounded-2xl border border-line bg-white p-5 shadow-panel" onSubmit={submit}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-ink-950">生成选题</h2>
          <p className="mt-1 text-sm text-ink-500">提交后进入异步生成队列，不会自动采纳。</p>
        </div>
        <button className={primaryButton} disabled={submitting} type="submit">
          {submitting ? '提交中…' : '生成选题'}
        </button>
      </div>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="text-sm text-ink-700">
          工作区
          <select
            className={controlClass}
            name="workspace_id"
            onChange={(event) => {
              setWorkspaceId(event.target.value);
              setProjectId('');
            }}
            required
            value={workspaceId}
          >
            <option value="">请选择工作区</option>
            {workspaces.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-ink-700">
          项目
          <select
            className={controlClass}
            disabled={!workspaceId}
            name="project_id"
            onChange={(event) => setProjectId(event.target.value)}
            required
            value={projectId}
          >
            <option value="">请选择项目</option>
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend className="text-sm text-ink-700">关键词集</legend>
          <div className="mt-2 space-y-2">
            {keywordSets.map((item) => (
              <label className="flex items-center gap-2 text-sm" key={item.id}>
                <input name="keyword_set_ids" type="checkbox" value={item.id} />
                {item.name}
              </label>
            ))}
            {projectId && keywordSets.length === 0 ? (
              <p className="text-xs text-ink-500">该项目还没有可用的关键词集。</p>
            ) : null}
          </div>
        </fieldset>
        <TextField label="种子问题（逗号或换行分隔）" name="seed_queries" />
        <label className="text-sm text-ink-700">
          生成数量
          <input
            className={controlClass}
            defaultValue="10"
            max="50"
            min="1"
            name="max_topics"
            required
            type="number"
          />
        </label>
        <fieldset>
          <legend className="text-sm text-ink-700">目标平台</legend>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
            {PLATFORM_OPTIONS.map(([code, label], index) => (
              <label className="flex items-center gap-2 text-sm text-ink-700" key={code}>
                <input
                  defaultChecked={index === 0}
                  name="platform_codes"
                  type="checkbox"
                  value={code}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
    </form>
  );
}

function TopicCard({
  busy,
  canManage,
  onAdopt,
  topic,
}: {
  busy: boolean;
  canManage: boolean;
  onAdopt: (topic: TopicCandidate) => Promise<void>;
  topic: TopicCandidate;
}) {
  const hasEvidence = topic.evidence_ids.length > 0;
  return (
    <li className="rounded-2xl border border-line bg-white p-5 shadow-panel">
      <div className="flex flex-col justify-between gap-5 lg:flex-row">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <RiskBadge risk={topic.risk_level} />
            <StatusBadge status={topic.status} />
            <span className="text-xs font-semibold text-ink-500">优先级 {topic.priority}</span>
          </div>
          <h2 className="mt-3 text-lg font-semibold text-ink-950">{topic.question}</h2>
          <dl className="mt-4 grid gap-3 text-sm text-ink-700 sm:grid-cols-2 lg:grid-cols-4">
            <Detail label="意图" value={topic.intent} />
            <Detail label="实体" value={topic.entities.join('、')} />
            <Detail label="证据" value={hasEvidence ? `${topic.evidence_ids.length} 条` : '无'} />
            <Detail label="平台" value={topic.platform_codes.map(platformLabel).join('、')} />
          </dl>
          {!hasEvidence ? (
            <p className="mt-4 rounded-control bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
              缺少资料依据：补充资料前不能采纳为内容需求。
            </p>
          ) : null}
        </div>
        {canManage && topic.status === 'proposed' ? (
          <div className="shrink-0">
            <button
              aria-describedby={!hasEvidence ? `risk-${topic.id}` : undefined}
              className={primaryButton}
              disabled={busy || !hasEvidence}
              onClick={() => void onAdopt(topic)}
              type="button"
            >
              采纳为内容需求
            </button>
            {!hasEvidence ? (
              <span className="sr-only" id={`risk-${topic.id}`}>
                缺少证据，禁止采纳
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function Filter({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: readonly (readonly [string, string])[];
  value?: string | undefined;
}) {
  return (
    <label className="text-sm text-ink-700">
      {label}
      <select
        className={controlClass}
        onChange={(event) => onChange(event.currentTarget.value)}
        value={value ?? ''}
      >
        <option value="">全部</option>
        {options.map(([code, name]) => (
          <option key={code} value={code}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

function TextField({
  label,
  name,
  required = false,
}: {
  label: string;
  name: string;
  required?: boolean;
}) {
  return (
    <label className="text-sm text-ink-700">
      {label}
      <input className={controlClass} name={name} required={required} />
    </label>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className="mt-1">{value}</dd>
    </div>
  );
}

function RiskBadge({ risk }: { risk: TopicRisk }) {
  const labels = { low: '低风险', medium: '中风险', high: '高风险', critical: '严重风险' } as const;
  return (
    <span className="rounded-full bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-700">
      {labels[risk]}
    </span>
  );
}

function StatusBadge({ status }: { status: TopicStatus }) {
  const labels = { proposed: '待采纳', adopted: '已采纳', archived: '已归档' } as const;
  return (
    <span className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700">
      {labels[status]}
    </span>
  );
}

function StatePanel({ text, title }: { text: string; title: string }) {
  return (
    <section className="mt-5 rounded-2xl border border-line bg-white p-8 text-center shadow-panel">
      <h2 className="text-xl font-semibold text-ink-950">{title}</h2>
      <p className="mt-3 text-sm text-ink-500">{text}</p>
    </section>
  );
}

function ListSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="正在加载候选选题"
      className="mt-5 h-72 animate-pulse rounded-2xl border border-line bg-white"
    />
  );
}

function readFilters(): TopicFilters {
  if (typeof window === 'undefined') return {};
  const query = new URLSearchParams(window.location.search);
  const platformCode = PlatformCodeSchema.safeParse(query.get('platform_code'));
  const riskLevel = TopicRiskSchema.safeParse(query.get('risk_level'));
  const status = TopicStatusSchema.safeParse(query.get('status'));
  return {
    ...(platformCode.success ? { platformCode: platformCode.data } : {}),
    ...(riskLevel.success ? { riskLevel: riskLevel.data } : {}),
    ...(status.success ? { status: status.data } : {}),
  };
}

function platformLabel(code: PlatformCode): string {
  return PLATFORM_OPTIONS.find(([value]) => value === code)?.[1] ?? code;
}

function splitValues(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,\n]/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function isPlatformCode(value: string): value is PlatformCode {
  return PlatformCodeSchema.safeParse(value).success;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function readCookie(name: string): string {
  const prefix = `${encodeURIComponent(name)}=`;
  const cookie = document.cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : '';
}

const controlClass =
  'mt-2 h-11 w-full rounded-control border border-line bg-white px-3 text-sm text-ink-950 focus:border-brand-500 focus:outline-none';
const primaryButton =
  'h-11 rounded-control bg-brand-600 px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50';
const secondaryButton =
  'h-11 rounded-control border border-brand-600 px-5 text-sm font-semibold text-brand-700 disabled:opacity-60';
