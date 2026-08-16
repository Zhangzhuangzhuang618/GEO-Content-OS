'use client';

import { useEffect, useState } from 'react';
import { skillLabel } from '../human-readable';
import {
  createPrompt,
  createRule,
  listPlatformConfig,
  PlatformConfigRequestError,
  transitionPrompt,
  transitionRule,
} from './platform-config-api';
import {
  RulesSchema,
  SkillNameSchema,
  type ConfigStatus,
  type PlatformCode,
  type PromptVersion,
  type RuleVersion,
  type SkillName,
} from './platform-config.schema';

const SKILLS = SkillNameSchema.options;
const PLATFORMS: readonly [PlatformCode, string][] = [
  ['official_site', '官网'],
  ['baijiahao', '百家号'],
  ['sohu', '搜狐号'],
  ['lieju', '列举网'],
  ['toutiao', '头条号'],
  ['zhihu', '知乎'],
  ['xiaohongshu', '小红书'],
  ['wechat_mp', '微信公众号'],
  ['douyin', '抖音'],
];

export function PlatformConfigManager() {
  const initial = readLocation();
  const [tab, setTab] = useState<'prompts' | 'rules'>(initial.tab);
  const [filters, setFilters] = useState(initial.filters);
  const [prompts, setPrompts] = useState<PromptVersion[]>([]);
  const [rules, setRules] = useState<RuleVersion[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'permission' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      setState('loading');
      try {
        const result = await listPlatformConfig(filters, controller.signal);
        if (controller.signal.aborted) return;
        setPrompts(result.prompts);
        setRules(result.rules);
        setState('ready');
      } catch (error) {
        if (controller.signal.aborted) return;
        setState(
          error instanceof PlatformConfigRequestError && error.status === 403
            ? 'permission'
            : 'error',
        );
      }
    })();
    return () => controller.abort();
  }, [filters]);

  function navigate(nextTab: typeof tab, nextFilters = filters) {
    setTab(nextTab);
    setFilters(nextFilters);
    const query = new URLSearchParams({ tab: nextTab });
    if (nextFilters.status) query.set('status', nextFilters.status);
    if (nextFilters.skill) query.set('skill', nextFilters.skill);
    if (nextFilters.platform) query.set('platform', nextFilters.platform);
    window.history.replaceState(null, '', `/set-03?${query}`);
  }

  async function mutatePrompt(
    id: string,
    work: (csrf: string) => Promise<PromptVersion>,
    success: string,
  ) {
    const csrf = readCookie('geo_csrf');
    if (!csrf) return setMessage('安全令牌尚未就绪，请刷新页面后重试。');
    setBusyId(id);
    setMessage(null);
    try {
      const updated = await work(csrf);
      setPrompts((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setMessage(success);
    } catch {
      setMessage('操作失败；状态、版本或平台权限可能已经变化，请刷新后重试。');
    } finally {
      setBusyId(null);
    }
  }

  async function mutateRule(
    id: string,
    work: (csrf: string) => Promise<RuleVersion>,
    success: string,
  ) {
    const csrf = readCookie('geo_csrf');
    if (!csrf) return setMessage('安全令牌尚未就绪，请刷新页面后重试。');
    setBusyId(id);
    setMessage(null);
    try {
      const updated = await work(csrf);
      setRules((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setMessage(success);
    } catch {
      setMessage('操作失败；状态、版本或平台权限可能已经变化，请刷新后重试。');
    } finally {
      setBusyId(null);
    }
  }

  if (state === 'loading')
    return <StatePanel busy text="正在读取 AI 生成指令与平台规则版本。" title="正在加载平台配置" />;
  if (state === 'permission')
    return (
      <StatePanel
        text="该页面仅对平台运营管理员开放，不读取任何企业内容。"
        title="无权管理平台配置"
      />
    );
  if (state === 'error')
    return <StatePanel text="请检查网络或会话状态后刷新页面。" title="无法加载平台配置" />;

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-line bg-white p-4 shadow-panel sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-2" role="tablist" aria-label="配置类型">
            <TabButton active={tab === 'prompts'} onClick={() => navigate('prompts')}>
              AI 生成指令
            </TabButton>
            <TabButton active={tab === 'rules'} onClick={() => navigate('rules')}>
              平台规则
            </TabButton>
          </div>
          <button
            className={primaryButton}
            onClick={() => setShowCreate((value) => !value)}
            type="button"
          >
            {showCreate ? '收起创建表单' : '创建新版本'}
          </button>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <select
            aria-label="状态筛选"
            className={controlClass}
            onChange={(event) => navigate(tab, { ...filters, status: event.currentTarget.value })}
            value={filters.status}
          >
            <option value="">全部状态</option>
            <option value="draft">草稿</option>
            <option value="published">已发布</option>
            <option value="retired">已退役</option>
          </select>
          {tab === 'prompts' ? (
            <select
              aria-label="处理步骤筛选"
              className={controlClass}
              onChange={(event) => navigate(tab, { ...filters, skill: event.currentTarget.value })}
              value={filters.skill}
            >
              <option value="">全部处理步骤</option>
              {SKILLS.map((skill) => (
                <option key={skill} value={skill}>
                  {skillLabel(skill)}
                </option>
              ))}
            </select>
          ) : (
            <select
              aria-label="平台筛选"
              className={controlClass}
              onChange={(event) =>
                navigate(tab, { ...filters, platform: event.currentTarget.value })
              }
              value={filters.platform}
            >
              <option value="">全部平台</option>
              {PLATFORMS.map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          )}
        </div>
      </section>

      {showCreate ? (
        tab === 'prompts' ? (
          <PromptCreateForm
            onCreated={(item) => {
              setPrompts((items) => [item, ...items]);
              setShowCreate(false);
              setMessage('AI 生成指令草稿已创建。');
            }}
          />
        ) : (
          <RuleCreateForm
            onCreated={(item) => {
              setRules((items) => [item, ...items]);
              setShowCreate(false);
              setMessage('平台规则草稿已创建。');
            }}
          />
        )
      ) : null}

      {tab === 'prompts' ? (
        <VersionList empty="暂无 AI 生成指令版本。">
          {prompts.map((item) => (
            <VersionCard
              busy={busyId === item.id}
              compatibleSchema={item.schema_version}
              createdBy={item.created_by_name}
              key={item.id}
              label={skillLabel(item.skill_name)}
              onPublish={() =>
                void mutatePrompt(
                  item.id,
                  (csrf) => transitionPrompt(item, 'publish', csrf),
                  'AI 生成指令已发布；已发布内容不会被覆盖。',
                )
              }
              onRetire={() => {
                const reason = window.prompt('退役/回滚原因（必填）')?.trim();
                if (reason)
                  void mutatePrompt(
                    item.id,
                    (csrf) => transitionPrompt(item, 'retire', csrf, reason),
                    'AI 生成指令已停用。需要恢复时，请基于旧内容创建新版本。',
                  );
              }}
              onTest={() =>
                setMessage(
                  item.system_prompt.trim() && item.task_template.trim()
                    ? '本地契约测试通过；未调用模型或真实平台。'
                    : '本地检查失败：AI 生成指令内容为空。',
                )
              }
              publishedBy={item.published_by_name}
              semanticVersion={item.semantic_version}
              status={item.status}
              summary={item.change_summary}
              version={item.version}
            >
              <details className="mt-4 text-sm text-ink-700">
                <summary className="cursor-pointer font-medium">查看 AI 生成指令内容</summary>
                <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-control bg-surface-subtle p-3">
                  {item.system_prompt}
                  {'\n\n--- TASK TEMPLATE ---\n'}
                  {item.task_template}
                </pre>
              </details>
            </VersionCard>
          ))}
        </VersionList>
      ) : (
        <VersionList empty="暂无平台规则版本。">
          {rules.map((item) => (
            <VersionCard
              busy={busyId === item.id}
              compatibleSchema={String(item.rules.schema_version)}
              createdBy={item.created_by_name}
              key={item.id}
              label={platformLabel(item.platform_code)}
              onPublish={() =>
                void mutateRule(
                  item.id,
                  (csrf) => transitionRule(item, 'publish', csrf),
                  '平台规则已发布；内容保持不可覆盖。',
                )
              }
              onRetire={() => {
                const reason = window.prompt('退役/回滚原因（必填）')?.trim();
                if (reason)
                  void mutateRule(
                    item.id,
                    (csrf) => transitionRule(item, 'retire', csrf, reason),
                    '平台规则已退役。需要恢复旧规则时，请创建新版本。',
                  );
              }}
              onTest={() =>
                setMessage(
                  RulesSchema.safeParse(item.rules).success
                    ? '本地 platform-rules@1 契约测试通过；未调用真实平台。'
                    : '本地契约测试失败：规则不兼容 platform-rules@1。',
                )
              }
              publishedBy={item.published_by_name}
              semanticVersion={item.semantic_version}
              status={item.status}
              summary={item.change_summary}
              version={item.version}
            >
              <pre className="mt-4 max-h-72 overflow-auto whitespace-pre-wrap rounded-control bg-surface-subtle p-3 text-sm text-ink-700">
                {JSON.stringify(item.rules, null, 2)}
              </pre>
            </VersionCard>
          ))}
        </VersionList>
      )}

      <div aria-live="polite" className="min-h-10">
        {message ? (
          <p className="rounded-control bg-brand-50 px-3 py-2 text-sm text-brand-700" role="status">
            {message}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function PromptCreateForm({ onCreated }: { onCreated(item: PromptVersion): void }) {
  const [skillName, setSkillName] = useState<SkillName>('content-writer');
  const [semanticVersion, setSemanticVersion] = useState('');
  const [schemaVersion, setSchemaVersion] = useState('');
  const [changeSummary, setChangeSummary] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [taskTemplate, setTaskTemplate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const csrf = readCookie('geo_csrf');
    if (!csrf) return setError('安全令牌尚未就绪。');
    if (!semanticVersion || !schemaVersion || !changeSummary || !systemPrompt || !taskTemplate)
      return setError('请完整填写版本、兼容数据格式、变更说明和 AI 指令内容。');
    setBusy(true);
    setError(null);
    try {
      onCreated(
        await createPrompt(
          {
            changeSummary,
            schemaVersion,
            semanticVersion,
            skillName,
            systemPrompt,
            taskTemplate,
          },
          csrf,
        ),
      );
    } catch {
      setError('创建失败；语义版本、内容摘要或字段可能重复或无效。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className={formClass} onSubmit={submit}>
      <h2 className="text-lg font-semibold text-ink-950">创建 AI 生成指令草稿</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Field label="处理步骤" name="prompt-skill">
          <select
            className={controlClass}
            id="prompt-skill"
            onChange={(event) => setSkillName(event.currentTarget.value as SkillName)}
            value={skillName}
          >
            {SKILLS.map((skill) => (
              <option key={skill} value={skill}>
                {skillLabel(skill)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="语义版本" name="prompt-version">
          <input
            className={controlClass}
            id="prompt-version"
            onChange={(event) => setSemanticVersion(event.currentTarget.value)}
            placeholder="1.0.0"
            value={semanticVersion}
          />
        </Field>
        <Field label="兼容数据格式" name="prompt-schema">
          <input
            className={controlClass}
            id="prompt-schema"
            onChange={(event) => setSchemaVersion(event.currentTarget.value)}
            placeholder="content-writer-data@1"
            value={schemaVersion}
          />
        </Field>
      </div>
      <Field label="变更说明" name="prompt-summary">
        <input
          className={controlClass}
          id="prompt-summary"
          onChange={(event) => setChangeSummary(event.currentTarget.value)}
          value={changeSummary}
        />
      </Field>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="系统指令" name="system-prompt">
          <textarea
            className={textAreaClass}
            id="system-prompt"
            onChange={(event) => setSystemPrompt(event.currentTarget.value)}
            value={systemPrompt}
          />
        </Field>
        <Field label="任务模板" name="task-template">
          <textarea
            className={textAreaClass}
            id="task-template"
            onChange={(event) => setTaskTemplate(event.currentTarget.value)}
            value={taskTemplate}
          />
        </Field>
      </div>
      <SubmitRow busy={busy} error={error} />
    </form>
  );
}

function RuleCreateForm({ onCreated }: { onCreated(item: RuleVersion): void }) {
  const [platformCode, setPlatformCode] = useState<PlatformCode>('official_site');
  const [semanticVersion, setSemanticVersion] = useState('');
  const [changeSummary, setChangeSummary] = useState('');
  const [rulesJson, setRulesJson] = useState(
    JSON.stringify({ schema_version: 'platform-rules@1' }, null, 2),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const csrf = readCookie('geo_csrf');
    if (!csrf) return setError('安全令牌尚未就绪。');
    let rules: unknown;
    try {
      rules = JSON.parse(rulesJson);
    } catch {
      return setError('规则 JSON 无法解析。');
    }
    const parsed = RulesSchema.safeParse(rules);
    if (!parsed.success) return setError('规则必须兼容 platform-rules@1。');
    if (!semanticVersion || !changeSummary) return setError('请填写语义版本和变更说明。');
    setBusy(true);
    setError(null);
    try {
      onCreated(
        await createRule(
          { changeSummary, platformCode, rules: parsed.data, semanticVersion },
          csrf,
        ),
      );
    } catch {
      setError('创建失败；语义版本、内容摘要或字段可能重复或无效。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className={formClass} onSubmit={submit}>
      <h2 className="text-lg font-semibold text-ink-950">创建平台规则草稿</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Field label="平台" name="rule-platform">
          <select
            className={controlClass}
            id="rule-platform"
            onChange={(event) => setPlatformCode(event.currentTarget.value as PlatformCode)}
            value={platformCode}
          >
            {PLATFORMS.map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="语义版本" name="rule-version">
          <input
            className={controlClass}
            id="rule-version"
            onChange={(event) => setSemanticVersion(event.currentTarget.value)}
            placeholder="1.0.0"
            value={semanticVersion}
          />
        </Field>
        <Field label="变更说明" name="rule-summary">
          <input
            className={controlClass}
            id="rule-summary"
            onChange={(event) => setChangeSummary(event.currentTarget.value)}
            value={changeSummary}
          />
        </Field>
      </div>
      <Field label="规则 JSON" name="rule-json">
        <textarea
          className={textAreaClass}
          id="rule-json"
          onChange={(event) => setRulesJson(event.currentTarget.value)}
          value={rulesJson}
        />
      </Field>
      <SubmitRow busy={busy} error={error} />
    </form>
  );
}

function VersionCard({
  busy,
  children,
  compatibleSchema,
  createdBy,
  label,
  onPublish,
  onRetire,
  onTest,
  publishedBy,
  semanticVersion,
  status,
  summary,
  version,
}: {
  busy: boolean;
  children: React.ReactNode;
  compatibleSchema: string;
  createdBy: string;
  label: string;
  onPublish(): void;
  onRetire(): void;
  onTest(): void;
  publishedBy: string | null;
  semanticVersion: string;
  status: ConfigStatus;
  summary: string;
  version: number;
}) {
  return (
    <article className="rounded-2xl border border-line bg-white p-5 shadow-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-ink-950">
            {label} · v{semanticVersion}
          </h3>
          <p className="mt-1 text-sm text-ink-500">
            数据格式：{compatibleSchema} · 配置版本 {version}
          </p>
        </div>
        <span className="rounded-full bg-brand-50 px-3 py-1 text-sm font-semibold text-brand-700">
          {statusLabel(status)}
        </span>
      </div>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-ink-500">创建人</dt>
          <dd className="mt-1 text-ink-950">{createdBy}</dd>
        </div>
        <div>
          <dt className="text-ink-500">发布人</dt>
          <dd className="mt-1 text-ink-950">{publishedBy ?? '尚未发布'}</dd>
        </div>
        <div>
          <dt className="text-ink-500">变更说明</dt>
          <dd className="mt-1 text-ink-950">{summary}</dd>
        </div>
      </dl>
      {children}
      {status !== 'draft' ? (
        <p className="mt-4 text-sm font-medium text-ink-700">
          已发布版本不可覆盖，只能退役或创建新版本。
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button className={secondaryButton} disabled={busy} onClick={onTest} type="button">
          本地测试
        </button>
        {status === 'draft' ? (
          <button className={primaryButton} disabled={busy} onClick={onPublish} type="button">
            发布
          </button>
        ) : null}
        {status === 'published' ? (
          <button className={dangerButton} disabled={busy} onClick={onRetire} type="button">
            退役/回滚
          </button>
        ) : null}
      </div>
    </article>
  );
}

function VersionList({ children, empty }: { children: React.ReactNode; empty: string }) {
  const items = Array.isArray(children) ? children : [children];
  return items.length === 0 ? (
    <StatePanel text="请调整筛选条件或创建第一个版本。" title={empty} />
  ) : (
    <section className="space-y-4">{children}</section>
  );
}

function TabButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick(): void;
}) {
  return (
    <button
      aria-selected={active}
      className={active ? primaryButton : secondaryButton}
      onClick={onClick}
      role="tab"
      type="button"
    >
      {children}
    </button>
  );
}

function Field({
  children,
  label,
  name,
}: {
  children: React.ReactNode;
  label: string;
  name: string;
}) {
  return (
    <div className="mt-4">
      <label className="text-sm font-medium text-ink-700" htmlFor={name}>
        {label}
      </label>
      {children}
    </div>
  );
}

function SubmitRow({ busy, error }: { busy: boolean; error: string | null }) {
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-red-700" role={error ? 'alert' : undefined}>
        {error}
      </p>
      <button className={primaryButton} disabled={busy} type="submit">
        {busy ? '正在创建…' : '创建草稿'}
      </button>
    </div>
  );
}

function StatePanel({
  busy = false,
  text,
  title,
}: {
  busy?: boolean;
  text: string;
  title: string;
}) {
  return (
    <section
      aria-busy={busy}
      className="rounded-2xl border border-line bg-white p-8 text-center shadow-panel"
    >
      <h2 className="text-xl font-semibold text-ink-950">{title}</h2>
      <p className="mt-3 text-sm text-ink-500">{text}</p>
    </section>
  );
}

function readLocation() {
  if (typeof window === 'undefined') {
    return {
      filters: { platform: '', skill: '', status: '' },
      tab: 'prompts' as const,
    };
  }
  const query = new URLSearchParams(window.location.search);
  return {
    filters: {
      platform: query.get('platform') ?? '',
      skill: query.get('skill') ?? '',
      status: query.get('status') ?? '',
    },
    tab: query.get('tab') === 'rules' ? ('rules' as const) : ('prompts' as const),
  };
}

function statusLabel(status: ConfigStatus) {
  return status === 'draft' ? 'Draft' : status === 'published' ? '已发布' : '已退役';
}

function platformLabel(code: PlatformCode) {
  return PLATFORMS.find(([value]) => value === code)?.[1] ?? code;
}

function readCookie(name: string) {
  const prefix = `${encodeURIComponent(name)}=`;
  const cookie = document.cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : '';
}

const formClass = 'rounded-2xl border border-line bg-white p-5 shadow-panel sm:p-6';
const controlClass =
  'mt-2 block h-11 w-full rounded-control border border-line bg-white px-3 text-sm text-ink-950 focus:border-brand-500 focus:outline-2 focus:outline-offset-2 disabled:bg-surface-subtle';
const textAreaClass =
  'mt-2 block min-h-44 w-full rounded-control border border-line bg-white p-3 font-mono text-sm text-ink-950 focus:border-brand-500 focus:outline-2 focus:outline-offset-2';
const primaryButton =
  'h-11 rounded-control bg-brand-600 px-5 text-sm font-semibold text-white focus:outline-2 focus:outline-offset-2 disabled:opacity-60';
const secondaryButton =
  'h-11 rounded-control border border-line bg-white px-4 text-sm font-semibold text-ink-700 focus:outline-2 focus:outline-offset-2 disabled:opacity-60';
const dangerButton =
  'h-11 rounded-control border border-red-300 bg-white px-4 text-sm font-semibold text-red-700 focus:outline-2 focus:outline-offset-2 disabled:opacity-60';
