'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { listAvailableTenants, TenantRequestError } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import { listProjects } from '../know-02/source-upload-api';
import type { ProjectChoice } from '../know-02/source-upload.schema';
import { listActiveWorkspaces } from '../str-02/brand-profile-api';
import {
  createKeywordSet,
  getKeywordSet,
  listKeywordSets,
  KeywordSetRequestError,
  upsertKeywords,
} from './keyword-set-api';
import {
  KeywordInputSchema,
  type Keyword,
  type KeywordInput,
  type KeywordIntent,
  type KeywordSet,
  type KeywordSetDetail,
  type KeywordStatus,
  type PlatformCode,
} from './keyword-set.schema';

const MANAGER_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'strategy_editor']);
const PLATFORM_OPTIONS = [
  ['official_site', '官网'],
  ['baijiahao', '百家号'],
  ['toutiao', '头条号'],
  ['zhihu', '知乎'],
  ['xiaohongshu', '小红书'],
  ['wechat_mp', '微信公众号'],
  ['douyin', '抖音'],
] as const satisfies readonly (readonly [PlatformCode, string])[];

interface Filters {
  readonly keywordSetId?: string;
  readonly projectId?: string;
  readonly status?: 'active' | 'archived';
}

export function KeywordSetManager() {
  const [filters, setFilters] = useState<Filters>(readFilters);
  const [sets, setSets] = useState<KeywordSet[]>([]);
  const [detail, setDetail] = useState<KeywordSetDetail | null>(null);
  const [state, setState] = useState<
    'loading' | 'ready' | 'error' | 'permission' | 'unauthenticated'
  >('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<readonly { id: string; name: string }[]>([]);
  const [projects, setProjects] = useState<readonly ProjectChoice[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [projectId, setProjectId] = useState(filters.projectId ?? '');
  const [showCreateSet, setShowCreateSet] = useState(false);
  const [creatingSet, setCreatingSet] = useState(false);

  const load = useCallback(async (next: Filters, signal?: AbortSignal) => {
    setState('loading');
    try {
      const tenants = await listAvailableTenants(signal);
      const role = tenants.find((tenant) => tenant.is_active)?.role_code;
      if (!role || !MANAGER_ROLES.has(role)) {
        setState('permission');
        return;
      }
      const items = await listKeywordSets(
        {
          ...(next.projectId ? { projectId: next.projectId } : {}),
          ...(next.status ? { status: next.status } : {}),
        },
        signal,
      );
      const selectedId = items.some((item) => item.id === next.keywordSetId)
        ? next.keywordSetId
        : items[0]?.id;
      const selected = selectedId ? await getKeywordSet(selectedId, signal) : null;
      if (signal?.aborted) return;
      setSets(items);
      setDetail(selected);
      setState('ready');
    } catch (error) {
      if (signal?.aborted) return;
      if (
        (error instanceof TenantRequestError || error instanceof KeywordSetRequestError) &&
        error.status === 401
      ) {
        setState('unauthenticated');
      } else {
        setState(
          error instanceof KeywordSetRequestError && error.status === 403 ? 'permission' : 'error',
        );
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(filters, controller.signal);
    return () => controller.abort();
  }, [filters, load]);

  useEffect(() => {
    const controller = new AbortController();
    void listActiveWorkspaces(controller.signal)
      .then(setWorkspaces)
      .catch(() => {
        if (!controller.signal.aborted) setMessage('无法加载工作区，请稍后重试。');
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!workspaceId) {
      setProjects([]);
      return;
    }
    const controller = new AbortController();
    void listProjects(workspaceId, controller.signal)
      .then(setProjects)
      .catch(() => {
        if (!controller.signal.aborted) setMessage('无法加载项目，请稍后重试。');
      });
    return () => controller.abort();
  }, [workspaceId]);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const status = String(data.get('set_status') ?? '');
    const next: Filters = {
      ...(projectId ? { projectId } : {}),
      ...(status === 'active' || status === 'archived' ? { status } : {}),
    };
    setFilters(next);
    writeFilters(next);
  }

  function changeWorkspace(id: string) {
    setWorkspaceId(id);
    setProjectId('');
    setProjects([]);
    setShowCreateSet(false);
  }

  async function createSet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('name') ?? '').trim();
    const csrf = readCookie('geo_csrf');
    if (!projectId) {
      setMessage('请先选择新关键词集所属的工作区和项目。');
      return;
    }
    if (!name) {
      setMessage('请输入关键词集名称。');
      return;
    }
    if (!csrf) {
      setMessage('登录状态已失效，请重新登录。');
      return;
    }
    setCreatingSet(true);
    setMessage(null);
    try {
      const created = await createKeywordSet({ name, projectId }, csrf);
      const next: Filters = { keywordSetId: created.id, projectId };
      setShowCreateSet(false);
      setFilters(next);
      writeFilters(next);
      setMessage(`关键词集“${created.name}”已创建，现在可以添加关键词。`);
    } catch (error) {
      if (error instanceof KeywordSetRequestError && error.status === 401) {
        setState('unauthenticated');
      } else if (error instanceof KeywordSetRequestError && error.status === 403) {
        setMessage('当前账号没有创建关键词集的权限。');
      } else {
        setMessage('创建关键词集失败，请稍后重试。');
      }
    } finally {
      setCreatingSet(false);
    }
  }

  function selectSet(id: string) {
    const next = { ...filters, ...(id ? { keywordSetId: id } : {}) };
    if (!id) delete next.keywordSetId;
    setFilters(next);
    writeFilters(next);
  }

  async function refresh(message?: string) {
    await load(filters);
    if (message) setMessage(message);
  }

  if (state === 'permission')
    return <StatePanel title="无权管理关键词集" text="当前角色不具备策略编辑权限。" />;
  if (state === 'unauthenticated')
    return (
      <StatePanel
        actionHref={`/auth-01?${new URLSearchParams({
          reason: 'session_expired',
          return_to: '/str-04',
        })}`}
        actionLabel="重新登录"
        title="登录状态已失效"
        text="重新登录后会返回关键词管理页面。"
      />
    );
  if (state === 'error')
    return (
      <StatePanel
        actionLabel="重新加载"
        onAction={() => void load(filters)}
        title="暂时无法加载关键词"
        text="服务暂时不可用，请稍后重试。"
      />
    );

  return (
    <section className="mt-8">
      <form
        className="rounded-2xl border border-line bg-white p-4 shadow-panel"
        onSubmit={applyFilters}
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_180px_auto] lg:items-end">
          <label className="text-sm text-ink-700">
            工作区
            <select
              className={controlClass}
              onChange={(event) => changeWorkspace(event.target.value)}
              value={workspaceId}
            >
              <option value="">全部工作区</option>
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
              onChange={(event) => {
                setProjectId(event.target.value);
                setShowCreateSet(false);
              }}
              value={projectId}
            >
              <option value="">全部项目</option>
              {projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-ink-700">
            关键词集状态
            <select className={controlClass} defaultValue={filters.status ?? ''} name="set_status">
              <option value="">全部</option>
              <option value="active">启用</option>
              <option value="archived">已归档</option>
            </select>
          </label>
          <button className={primaryButton} type="submit">
            应用筛选
          </button>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <button
            className={secondaryButton}
            disabled={!projectId}
            onClick={() => setShowCreateSet((current) => !current)}
            type="button"
          >
            新建关键词集
          </button>
          <p className="text-xs text-ink-500">
            {projectId
              ? '关键词必须归属于一个关键词集。创建后即可逐个添加或批量导入。'
              : '请先选择工作区和项目。'}
          </p>
        </div>
      </form>

      {showCreateSet && projectId ? (
        <form
          className="mt-5 rounded-2xl border border-line bg-white p-5 shadow-panel"
          onSubmit={createSet}
        >
          <h2 className="font-semibold text-ink-950">新建关键词集</h2>
          <p className="mt-1 text-sm text-ink-500">例如：官网核心关键词、搬家服务选题。</p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="flex-1 text-sm text-ink-700">
              关键词集名称
              <input
                className={controlClass}
                maxLength={120}
                name="name"
                placeholder="例如：官网核心关键词"
                required
                type="text"
              />
            </label>
            <button className={primaryButton} disabled={creatingSet} type="submit">
              {creatingSet ? '正在创建…' : '创建关键词集'}
            </button>
          </div>
        </form>
      ) : null}

      {state === 'loading' && sets.length === 0 ? (
        <StatePanel title="正在加载关键词集" text="正在读取当前项目范围内的数据。" />
      ) : sets.length === 0 ? (
        <StatePanel
          title="当前项目还没有关键词集"
          text={
            projectId
              ? '点击上方“新建关键词集”，创建后即可添加关键词。'
              : '先选择工作区和项目，再创建第一个关键词集。'
          }
        />
      ) : (
        <>
          <label className="mt-5 block rounded-2xl border border-line bg-white p-4 text-sm text-ink-700 shadow-panel">
            当前关键词集
            <select
              aria-label="当前关键词集"
              className={controlClass}
              onChange={(event) => selectSet(event.currentTarget.value)}
              value={detail?.id ?? ''}
            >
              {sets.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.status === 'active' ? '启用' : '已归档'}
                </option>
              ))}
            </select>
          </label>
          {detail ? <KeywordWorkspace detail={detail} onRefresh={refresh} /> : null}
        </>
      )}
      <div aria-live="polite" className="mt-4 min-h-6">
        {message ? <p role="status">{message}</p> : null}
      </div>
    </section>
  );
}

function KeywordWorkspace({
  detail,
  onRefresh,
}: {
  readonly detail: KeywordSetDetail;
  readonly onRefresh: (message?: string) => Promise<void>;
}) {
  const canWrite = detail.status === 'active';
  const [editing, setEditing] = useState<Keyword | null>(null);
  const [busy, setBusy] = useState(false);
  const [localMessage, setLocalMessage] = useState<string | null>(null);

  async function submitBatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = String(new FormData(event.currentTarget).get('batch') ?? '');
    let parsed: KeywordInput[];
    try {
      parsed = parseBatch(text);
    } catch (error) {
      setLocalMessage(error instanceof Error ? error.message : '批量数据格式错误。');
      return;
    }
    await save(parsed, `${parsed.length} 个关键词已导入或更新。`);
    if (parsed.length > 0) event.currentTarget.reset();
  }

  async function submitSingle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const parsed = KeywordInputSchema.safeParse({
      intent: data.get('intent'),
      platform_scope: data.getAll('platform_scope'),
      priority: Number(data.get('priority')),
      status: 'active',
      synonyms: [],
      term: data.get('term'),
    });
    if (!parsed.success) {
      setLocalMessage('请填写关键词、选择搜索意图，并至少选择一个适用平台。');
      return;
    }
    await save([parsed.data], `关键词“${parsed.data.term}”已添加。`);
    form.reset();
  }

  async function save(keywords: readonly KeywordInput[], success: string) {
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setLocalMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    setBusy(true);
    setLocalMessage(null);
    try {
      await upsertKeywords(detail.id, keywords, csrf);
      setEditing(null);
      await onRefresh(success);
    } catch (error) {
      setLocalMessage(
        error instanceof KeywordSetRequestError && error.status === 422
          ? '提交内容不符合字段约束，请检查 term、意图、优先级和平台范围。'
          : '保存失败，请稍后重试。',
      );
    } finally {
      setBusy(false);
    }
  }

  async function disable(keyword: Keyword) {
    await save([toInput(keyword, 'disabled')], `关键词“${keyword.term}”已禁用。`);
  }

  return (
    <div className="mt-5 grid gap-5 xl:grid-cols-[1fr_360px]">
      <div className="min-w-0 overflow-x-auto rounded-2xl border border-line bg-white shadow-panel">
        {detail.keywords.length === 0 ? (
          <StatePanel title="暂无关键词" text="使用右侧批量导入添加第一个关键词。" />
        ) : (
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="bg-surface-subtle text-ink-500">
              <tr>
                <th className="p-4">关键词</th>
                <th className="p-4">搜索意图</th>
                <th className="p-4">优先级</th>
                <th className="p-4">同义词</th>
                <th className="p-4">适用平台</th>
                <th className="p-4">状态</th>
                <th className="p-4">动作</th>
              </tr>
            </thead>
            <tbody>
              {detail.keywords.map((keyword) => (
                <tr className="border-t border-line" key={keyword.id}>
                  <td className="p-4 font-medium text-ink-950">{keyword.term}</td>
                  <td className="p-4">{keyword.intent}</td>
                  <td className="p-4">{keyword.priority}</td>
                  <td className="p-4">{keyword.synonyms.join('、') || '—'}</td>
                  <td className="p-4">{keyword.platform_scope.map(platformLabel).join('、')}</td>
                  <td className="p-4">{keyword.status === 'active' ? '启用' : '禁用'}</td>
                  <td className="p-4">
                    {canWrite ? (
                      <div className="flex gap-3">
                        <button
                          className="text-brand-700"
                          onClick={() => setEditing(keyword)}
                          type="button"
                        >
                          编辑
                        </button>
                        {keyword.status === 'active' ? (
                          <button
                            className="text-red-700 disabled:opacity-50"
                            disabled={busy}
                            onClick={() => void disable(keyword)}
                            type="button"
                          >
                            禁用
                          </button>
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-ink-500">只读</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <aside className="space-y-5">
        <form
          className="rounded-2xl border border-line bg-white p-5 shadow-panel"
          onSubmit={submitSingle}
        >
          <h2 className="font-semibold text-ink-950">添加关键词</h2>
          <p className="mt-1 text-xs leading-5 text-ink-500">
            先添加关键词，其他细节可以稍后编辑。
          </p>
          <TextField label="关键词" name="term" />
          <label className="mt-4 block text-sm text-ink-700">
            搜索意图
            <select className={controlClass} defaultValue="commercial" name="intent">
              <option value="commercial">比较或选择服务</option>
              <option value="informational">了解知识或方法</option>
              <option value="transactional">准备咨询或下单</option>
              <option value="navigational">查找品牌或页面</option>
            </select>
          </label>
          <label className="mt-4 block text-sm text-ink-700">
            新增关键词优先级
            <input
              className={controlClass}
              defaultValue="80"
              max="100"
              min="0"
              name="priority"
              type="number"
            />
          </label>
          <fieldset className="mt-4">
            <legend className="text-sm text-ink-700">适用平台</legend>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {PLATFORM_OPTIONS.map(([code, label]) => (
                <label className="flex items-center gap-2 text-sm" key={code}>
                  <input
                    defaultChecked={code === 'official_site'}
                    name="platform_scope"
                    type="checkbox"
                    value={code}
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <button
            className={`${primaryButton} mt-4 w-full`}
            disabled={busy || !canWrite}
            type="submit"
          >
            添加关键词
          </button>
        </form>
        <form
          className="rounded-2xl border border-line bg-white p-5 shadow-panel"
          onSubmit={submitBatch}
        >
          <h2 className="font-semibold text-ink-950">批量导入关键词</h2>
          <p className="mt-2 text-xs leading-5 text-ink-500">
            简单方式：每行输入一个关键词，默认用于官网、优先级 80。需要精细设置时，可使用 Tab
            分隔：关键词、意图、优先级、同义词、平台、状态。
          </p>
          <textarea
            aria-label="批量关键词"
            className={`${controlClass} min-h-40 font-mono text-xs`}
            name="batch"
            placeholder={'广州搬家公司推荐\n广州企业搬迁注意事项\n广州搬家收费标准'}
            required
          />
          <button
            className={`${primaryButton} mt-4 w-full`}
            disabled={busy || !canWrite}
            type="submit"
          >
            导入关键词
          </button>
        </form>
        {editing ? (
          <EditKeywordForm
            busy={busy}
            keyword={editing}
            onCancel={() => setEditing(null)}
            onInvalid={() => setLocalMessage('请填写 0–100 的优先级并至少选择一个平台。')}
            onSave={save}
          />
        ) : null}
        <div aria-live="polite" className="min-h-6 text-sm">
          {localMessage ? <p role="status">{localMessage}</p> : null}
        </div>
      </aside>
    </div>
  );
}

function EditKeywordForm({
  busy,
  keyword,
  onCancel,
  onInvalid,
  onSave,
}: {
  readonly busy: boolean;
  readonly keyword: Keyword;
  readonly onCancel: () => void;
  readonly onInvalid: () => void;
  readonly onSave: (keywords: readonly KeywordInput[], success: string) => Promise<void>;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const parsed = KeywordInputSchema.safeParse({
      intent: data.get('intent'),
      platform_scope: data.getAll('platform_scope'),
      priority: Number(data.get('priority')),
      status: data.get('status'),
      synonyms: splitPipe(String(data.get('synonyms') ?? '')),
      term: keyword.term,
    });
    if (!parsed.success) {
      onInvalid();
      return;
    }
    void onSave([parsed.data], `关键词“${keyword.term}”已更新。`);
  }
  return (
    <form className="rounded-2xl border border-line bg-white p-5 shadow-panel" onSubmit={submit}>
      <h2 className="font-semibold text-ink-950">编辑关键词</h2>
      <p className="mt-2 text-sm font-medium">{keyword.term}</p>
      <p className="mt-1 text-xs text-ink-500">term 是唯一键；改名需新增关键词并禁用旧项。</p>
      <label className="mt-4 block text-sm text-ink-700">
        意图
        <select className={controlClass} defaultValue={keyword.intent} name="intent">
          {INTENTS.map((intent) => (
            <option key={intent} value={intent}>
              {intent}
            </option>
          ))}
        </select>
      </label>
      <label className="mt-4 block text-sm text-ink-700">
        优先级
        <input
          className={controlClass}
          defaultValue={keyword.priority}
          max="100"
          min="0"
          name="priority"
          type="number"
        />
      </label>
      <TextField
        defaultValue={keyword.synonyms.join('|')}
        label="同义词（| 分隔）"
        name="synonyms"
      />
      <fieldset className="mt-4">
        <legend className="text-sm text-ink-700">平台范围</legend>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {PLATFORM_OPTIONS.map(([code, label]) => (
            <label className="flex items-center gap-2 text-sm" key={code}>
              <input
                defaultChecked={keyword.platform_scope.includes(code)}
                name="platform_scope"
                type="checkbox"
                value={code}
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="mt-4 block text-sm text-ink-700">
        状态
        <select className={controlClass} defaultValue={keyword.status} name="status">
          <option value="active">启用</option>
          <option value="disabled">禁用</option>
        </select>
      </label>
      <div className="mt-4 flex gap-3">
        <button className={primaryButton} disabled={busy} type="submit">
          保存
        </button>
        <button className={secondaryButton} onClick={onCancel} type="button">
          取消
        </button>
      </div>
    </form>
  );
}

const INTENTS: readonly KeywordIntent[] = [
  'informational',
  'commercial',
  'transactional',
  'navigational',
];
function parseBatch(value: string): KeywordInput[] {
  const rows = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (rows.length === 0) throw new Error('请至少输入一个关键词。');
  if (rows.length > 500) throw new Error('单次最多导入 500 个关键词。');
  const terms = new Set<string>();
  return rows.map((row, index) => {
    const columns = row.split('\t');
    const [term, intent, priority, synonyms = '', platforms = '', status = 'active', ...rest] =
      columns.length === 1
        ? [columns[0], 'commercial', '80', '', 'official_site', 'active']
        : columns;
    if (rest.length > 0) throw new Error(`第 ${index + 1} 行字段数超过 6 个。`);
    const parsed = KeywordInputSchema.safeParse({
      intent,
      platform_scope: splitPipe(platforms),
      priority: Number(priority),
      status,
      synonyms: splitPipe(synonyms),
      term,
    });
    if (!parsed.success) throw new Error(`第 ${index + 1} 行字段不符合约束。`);
    const normalized = parsed.data.term.toLowerCase();
    if (terms.has(normalized)) throw new Error(`第 ${index + 1} 行 term 在本次导入中重复。`);
    terms.add(normalized);
    return parsed.data;
  });
}
function toInput(keyword: Keyword, status: KeywordStatus): KeywordInput {
  return {
    intent: keyword.intent,
    platform_scope: keyword.platform_scope,
    priority: keyword.priority,
    status,
    synonyms: keyword.synonyms,
    term: keyword.term,
  };
}
function splitPipe(value: string) {
  return value
    .split('|')
    .map((item) => item.trim())
    .filter(Boolean);
}
function platformLabel(code: PlatformCode) {
  return PLATFORM_OPTIONS.find(([value]) => value === code)?.[1] ?? code;
}
function readFilters(): Filters {
  if (typeof window === 'undefined') return {};
  const query = new URLSearchParams(window.location.search);
  const status = query.get('status');
  const keywordSetId = query.get('keyword_set_id');
  const projectId = query.get('project_id');
  return {
    ...(keywordSetId ? { keywordSetId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(status === 'active' || status === 'archived' ? { status } : {}),
  };
}
function writeFilters(filters: Filters) {
  const query = new URLSearchParams();
  if (filters.projectId) query.set('project_id', filters.projectId);
  if (filters.status) query.set('status', filters.status);
  if (filters.keywordSetId) query.set('keyword_set_id', filters.keywordSetId);
  window.history.replaceState(null, '', query.size ? `/str-04?${query}` : '/str-04');
}
function readCookie(name: string) {
  const prefix = `${encodeURIComponent(name)}=`;
  const cookie = document.cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : '';
}
function TextField({
  defaultValue,
  label,
  name,
}: {
  readonly defaultValue?: string;
  readonly label: string;
  readonly name: string;
}) {
  return (
    <label className="mt-4 block text-sm text-ink-700">
      {label}
      <input className={controlClass} defaultValue={defaultValue} name={name} type="text" />
    </label>
  );
}
function StatePanel({
  actionHref,
  actionLabel,
  onAction,
  text,
  title,
}: {
  readonly actionHref?: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly text: string;
  readonly title: string;
}) {
  return (
    <div className="mt-5 rounded-2xl border border-line bg-white p-8 text-center shadow-panel">
      <h2 className="font-semibold text-ink-950">{title}</h2>
      <p className="mt-2 text-sm text-ink-500">{text}</p>
      {actionHref && actionLabel ? (
        <Link className={`${primaryButton} mt-5 inline-flex items-center`} href={actionHref}>
          {actionLabel}
        </Link>
      ) : null}
      {onAction && actionLabel ? (
        <button className={`${primaryButton} mt-5`} onClick={onAction} type="button">
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}
const controlClass =
  'mt-2 h-11 w-full rounded-control border border-line bg-white px-3 text-sm text-ink-950 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-100';
const primaryButton =
  'h-11 rounded-control bg-brand-600 px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50';
const secondaryButton =
  'h-11 rounded-control border border-line px-4 text-sm font-semibold text-ink-700';
