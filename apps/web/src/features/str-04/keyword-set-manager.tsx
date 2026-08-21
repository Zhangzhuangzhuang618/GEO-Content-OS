'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { listAvailableTenants, TenantRequestError } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import { listProjects } from '../know-02/source-upload-api';
import type { ProjectChoice } from '../know-02/source-upload.schema';
import { listActiveWorkspaces } from '../str-02/brand-profile-api';
import {
  batchKeywords,
  commitKeywordImport,
  createKeywordSet,
  getKeywordImport,
  listKeywords,
  listKeywordSets,
  KeywordSetRequestError,
  preflightKeywordImport,
  upsertKeywords,
} from './keyword-set-api';
import {
  KeywordInputSchema,
  type BatchKeywordOperation,
  type Keyword,
  type KeywordInput,
  type KeywordImportJob,
  type KeywordIntent,
  type KeywordSourceIntent,
  type KeywordSet,
  type KeywordSort,
  type KeywordStatus,
  type KeywordSuggestedPageType,
  type PlatformCode,
} from './keyword-set.schema';

const MANAGER_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'strategy_editor']);
const PLATFORM_OPTIONS = [
  ['official_site', '官网'],
  ['baijiahao', '百家号'],
  ['sohu', '搜狐号'],
  ['lieju', '列举网'],
  ['toutiao', '头条号'],
  ['zhihu', '知乎'],
  ['xiaohongshu', '小红书'],
  ['wechat_mp', '微信公众号'],
  ['douyin', '抖音'],
] as const satisfies readonly (readonly [PlatformCode, string])[];
const INTENT_OPTIONS = [
  ['informational', '了解知识或方法'],
  ['commercial', '比较或选择服务'],
  ['transactional', '准备咨询或下单'],
  ['navigational', '查找品牌或页面'],
] as const satisfies readonly (readonly [KeywordIntent, string])[];
const KEYWORDS_PER_PAGE = 20;

interface Filters {
  readonly keywordSetId?: string;
  readonly projectId?: string;
  readonly status?: 'active' | 'archived';
}

export function KeywordSetManager() {
  const [filters, setFilters] = useState<Filters>(readFilters);
  const [sets, setSets] = useState<KeywordSet[]>([]);
  const [detail, setDetail] = useState<KeywordSet | null>(null);
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
      const selected = selectedId ? (items.find((item) => item.id === selectedId) ?? null) : null;
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
          <section
            aria-label="关键词集列表"
            className="mt-5 rounded-2xl border border-line bg-white p-4 shadow-panel"
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-ink-950">关键词集</h2>
              <span className="text-xs text-ink-500">共 {sets.length} 个</span>
            </div>
            <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
              {sets.map((item) => {
                const selected = detail?.id === item.id;
                return (
                  <button
                    aria-pressed={selected}
                    className={`rounded-xl border p-3 text-left transition ${
                      selected
                        ? 'border-brand-600 bg-brand-50 text-brand-800'
                        : 'border-line bg-white text-ink-700 hover:border-brand-300'
                    }`}
                    key={item.id}
                    onClick={() => selectSet(item.id)}
                    type="button"
                  >
                    <span className="block font-medium">{item.name}</span>
                    <span className="mt-1 block text-xs opacity-75">
                      {item.status === 'active' ? '启用' : '已归档'}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
          {detail ? <KeywordWorkspace detail={detail} onMessage={setMessage} /> : null}
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
  onMessage,
}: {
  readonly detail: KeywordSet;
  readonly onMessage: (message: string | null) => void;
}) {
  const canWrite = detail.status === 'active';
  const [editing, setEditing] = useState<Keyword | null>(null);
  const [busy, setBusy] = useState(false);
  const [localMessage, setLocalMessage] = useState<string | null>(null);
  const [keywords, setKeywords] = useState<readonly Keyword[]>([]);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [keywordState, setKeywordState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<KeywordStatus | ''>('');
  const [platformFilter, setPlatformFilter] = useState<PlatformCode | ''>('');
  const [sort, setSort] = useState<KeywordSort>('priority_desc');
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [allFilteredSelected, setAllFilteredSelected] = useState(false);
  const [bulkEditing, setBulkEditing] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const selectedCount = allFilteredSelected ? totalCount : selectedIds.size;

  useEffect(() => {
    setPage(1);
    setPageInput('1');
    setTotalCount(0);
    setTotalPages(1);
    setEditing(null);
    setBulkEditing(false);
    setSelectedIds(new Set());
    setAllFilteredSelected(false);
    setSearch('');
    setStatusFilter('');
    setPlatformFilter('');
    setSort('priority_desc');
  }, [detail.id]);

  useEffect(() => setPageInput(String(page)), [page]);

  useEffect(() => {
    if (selectedCount === 0) setBulkEditing(false);
  }, [selectedCount]);

  useEffect(() => {
    const controller = new AbortController();
    setKeywordState('loading');
    void listKeywords(
      detail.id,
      {
        limit: KEYWORDS_PER_PAGE,
        page,
        ...(platformFilter ? { platformCode: platformFilter } : {}),
        ...(search ? { search } : {}),
        sort,
        ...(statusFilter ? { status: statusFilter } : {}),
      },
      controller.signal,
    )
      .then((page) => {
        if (controller.signal.aborted) return;
        setKeywords(page.data);
        const resolvedPage = page.meta.page ?? 1;
        setPage(resolvedPage);
        setTotalCount(page.meta.total_count ?? page.data.length);
        setTotalPages(page.meta.total_pages ?? 1);
        setKeywordState('ready');
      })
      .catch(() => {
        if (!controller.signal.aborted) setKeywordState('error');
      });
    return () => controller.abort();
  }, [detail.id, page, platformFilter, reloadToken, search, sort, statusFilter]);

  function applyKeywordFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const nextSearch = String(data.get('keyword_search') ?? '').trim();
    const rawStatus = String(data.get('keyword_status') ?? '');
    const rawPlatform = String(data.get('keyword_platform') ?? '');
    const rawSort = String(data.get('keyword_sort') ?? 'priority_desc');
    setSearch(nextSearch);
    setStatusFilter(rawStatus === 'active' || rawStatus === 'disabled' ? rawStatus : '');
    setPlatformFilter(
      PLATFORM_OPTIONS.some(([code]) => code === rawPlatform) ? (rawPlatform as PlatformCode) : '',
    );
    setSort(rawSort === 'priority_asc' ? 'priority_asc' : 'priority_desc');
    setPage(1);
    setSelectedIds(new Set());
    setAllFilteredSelected(false);
    setBulkEditing(false);
  }

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
      intents: data.getAll('intents'),
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
      setSelectedIds(new Set());
      setAllFilteredSelected(false);
      setBulkEditing(false);
      setReloadToken((current) => current + 1);
      onMessage(success);
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

  async function runBatch(
    input: Parameters<typeof batchKeywords>[1],
    success: (result: BatchKeywordOperation) => string,
  ): Promise<void> {
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setLocalMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    setBusy(true);
    setLocalMessage(null);
    try {
      const result = await batchKeywords(detail.id, input, csrf);
      setSelectedIds(new Set());
      setAllFilteredSelected(false);
      setBulkEditing(false);
      setReloadToken((current) => current + 1);
      onMessage(success(result));
    } catch (error) {
      if (error instanceof KeywordSetRequestError && error.status === 409) {
        setLocalMessage('当前关键词集状态不允许这次批量操作，请刷新后重试。');
      } else if (error instanceof KeywordSetRequestError && error.status === 422) {
        setLocalMessage('批量修改内容不符合字段约束，请检查后重试。');
      } else {
        setLocalMessage('批量操作失败，请稍后重试。');
      }
    } finally {
      setBusy(false);
    }
  }

  function submitBulkEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedCount === 0) {
      setLocalMessage('请先选择需要修改的关键词。');
      return;
    }
    const data = new FormData(event.currentTarget);
    const applyIntents = data.has('apply_intents');
    const applyPriority = data.has('apply_priority');
    const applyPlatforms = data.has('apply_platforms');
    const applyStatus = data.has('apply_status');
    if (!applyIntents && !applyPriority && !applyPlatforms && !applyStatus) {
      setLocalMessage('请至少勾选一个需要批量修改的字段。');
      return;
    }
    const intents = data.getAll('bulk_intents').map(String).filter(isKeywordIntent);
    const platforms = data.getAll('bulk_platforms').map(String).filter(isPlatformCode);
    const priority = Number(data.get('bulk_priority'));
    const status = String(data.get('bulk_status'));
    if (applyIntents && intents.length === 0) {
      setLocalMessage('批量修改搜索意图时，至少选择一项。');
      return;
    }
    if (applyPlatforms && platforms.length === 0) {
      setLocalMessage('批量修改适用平台时，至少选择一个平台。');
      return;
    }
    if (applyPriority && (!Number.isInteger(priority) || priority < 0 || priority > 100)) {
      setLocalMessage('批量优先级必须是 0–100 的整数。');
      return;
    }
    if (applyStatus && status !== 'active' && status !== 'disabled') {
      setLocalMessage('批量状态不符合约束。');
      return;
    }
    const changes = {
      ...(applyIntents ? { intents } : {}),
      ...(applyPlatforms ? { platform_scope: platforms } : {}),
      ...(applyPriority ? { priority } : {}),
      ...(applyStatus ? { status: status as KeywordStatus } : {}),
    };
    void runBatch(
      { action: 'update', changes, ...selectedBatchTarget() },
      (result) => `${result.affected_count} 个关键词已批量更新。`,
    );
  }

  function submitPageJump(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = Number(pageInput);
    if (!Number.isInteger(target) || target < 1 || target > totalPages) {
      setLocalMessage(`请输入 1–${totalPages} 之间的页码。`);
      return;
    }
    setLocalMessage(null);
    moveToPage(target);
  }

  function moveToPage(target: number) {
    if (!allFilteredSelected) {
      setSelectedIds(new Set());
      setBulkEditing(false);
    }
    setPage(target);
  }

  function toggleKeywordSelection(keywordId: string, selected: boolean) {
    if (allFilteredSelected) {
      if (!selected) {
        setAllFilteredSelected(false);
        setSelectedIds(
          new Set(
            keywords.filter((keyword) => keyword.id !== keywordId).map((keyword) => keyword.id),
          ),
        );
        setLocalMessage('已取消全部结果选择，当前仅保留本页勾选项。');
      }
      return;
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      if (selected) next.add(keywordId);
      else next.delete(keywordId);
      return next;
    });
  }

  function toggleCurrentPage(selected: boolean) {
    if (allFilteredSelected) {
      if (!selected) {
        setAllFilteredSelected(false);
        setSelectedIds(new Set());
        setBulkEditing(false);
      }
      return;
    }
    setSelectedIds(selected ? new Set(keywords.map((keyword) => keyword.id)) : new Set());
  }

  function deleteSelected() {
    if (selectedCount === 0) return;
    if (
      !window.confirm(
        `确定删除所选的 ${selectedCount} 个关键词吗？已被历史内容引用的关键词会保留，并提示改为禁用；其他删除不可撤销。`,
      )
    ) {
      return;
    }
    void runBatch({ action: 'delete', ...selectedBatchTarget() }, (result) => {
      if (result.skipped_referenced_count === 0) {
        return `${result.affected_count} 个未被引用的关键词已删除。`;
      }
      if (result.affected_count === 0) {
        return `没有可删除的关键词；${result.skipped_referenced_count} 个关键词已被历史内容引用，请改为批量禁用。`;
      }
      return `${result.affected_count} 个未被引用的关键词已删除；另有 ${result.skipped_referenced_count} 个已被历史内容引用，未删除，请改为批量禁用。`;
    });
  }

  function selectedBatchTarget() {
    if (!allFilteredSelected) return { keywordIds: [...selectedIds] };
    return {
      selection: {
        mode: 'all_filtered' as const,
        ...(platformFilter ? { platform_code: platformFilter } : {}),
        ...(search ? { search } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
      },
    };
  }

  function toggleAllFilteredSelection(selected: boolean) {
    setAllFilteredSelected(selected);
    setSelectedIds(new Set());
    if (!selected) setBulkEditing(false);
    setLocalMessage(null);
  }

  const handleImportComplete = useCallback(() => {
    setPage(1);
    setSelectedIds(new Set());
    setAllFilteredSelected(false);
    setBulkEditing(false);
    setReloadToken((current) => current + 1);
    onMessage('关键词表格导入完成。');
  }, [onMessage]);

  const allCurrentPageSelected =
    allFilteredSelected ||
    (keywords.length > 0 && keywords.every((keyword) => selectedIds.has(keyword.id)));

  return (
    <>
      <KeywordSpreadsheetImport
        canWrite={canWrite}
        keywordSetId={detail.id}
        onComplete={handleImportComplete}
      />
      <div className="mt-5 grid gap-5 xl:grid-cols-[1fr_360px]">
        <section
          aria-label="关键词列表"
          className="min-w-0 self-start overflow-hidden rounded-2xl border border-line bg-white shadow-panel"
        >
          <form
            className="flex flex-wrap items-end gap-3 border-b border-line p-4"
            key={detail.id}
            onSubmit={applyKeywordFilters}
          >
            <label className="min-w-56 flex-1 text-sm text-ink-700">
              搜索关键词
              <input className={controlClass} name="keyword_search" placeholder="输入关键词" />
            </label>
            <label className="w-36 text-sm text-ink-700">
              状态
              <select className={controlClass} name="keyword_status">
                <option value="">全部</option>
                <option value="active">启用</option>
                <option value="disabled">禁用</option>
              </select>
            </label>
            <label className="w-40 text-sm text-ink-700">
              适用平台
              <select className={controlClass} name="keyword_platform">
                <option value="">全部平台</option>
                {PLATFORM_OPTIONS.map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="w-40 text-sm text-ink-700">
              优先级排序
              <select className={controlClass} defaultValue="priority_desc" name="keyword_sort">
                <option value="priority_desc">从高到低</option>
                <option value="priority_asc">从低到高</option>
              </select>
            </label>
            <button className={secondaryButton} type="submit">
              筛选
            </button>
          </form>
          {canWrite ? (
            <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface-subtle px-4 py-3 text-sm">
              <span className="text-ink-700">
                {allFilteredSelected
                  ? `已选择全部 ${selectedCount} 个筛选结果`
                  : `已选 ${selectedCount} 个`}
              </span>
              {totalCount > 0 ? (
                <button
                  aria-pressed={allFilteredSelected}
                  className={allFilteredSelected ? primaryButton : secondaryButton}
                  disabled={busy}
                  onClick={() => toggleAllFilteredSelection(!allFilteredSelected)}
                  type="button"
                >
                  {allFilteredSelected ? '取消全部选择' : `选择全部 ${totalCount} 个筛选结果`}
                </button>
              ) : null}
              <button
                className={secondaryButton}
                disabled={busy || selectedCount === 0}
                onClick={() => {
                  setEditing(null);
                  setBulkEditing(true);
                }}
                type="button"
              >
                批量编辑
              </button>
              <button
                className={secondaryButton}
                disabled={busy || selectedCount === 0}
                onClick={() =>
                  void runBatch(
                    { action: 'disable', ...selectedBatchTarget() },
                    (result) => `${result.affected_count} 个关键词已批量禁用。`,
                  )
                }
                type="button"
              >
                批量禁用
              </button>
              <button
                className="rounded-control border border-red-300 px-3 py-2 font-medium text-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={busy || selectedCount === 0}
                onClick={deleteSelected}
                type="button"
              >
                批量删除
              </button>
              <span className="text-xs text-ink-500">
                表头仅选择当前页；“选择全部”覆盖当前筛选结果
              </span>
            </div>
          ) : null}
          {keywordState === 'loading' ? (
            <StatePanel title="正在加载关键词" text="正在读取当前页数据。" />
          ) : keywordState === 'error' ? (
            <StatePanel
              actionLabel="重新加载"
              onAction={() => setReloadToken((current) => current + 1)}
              title="暂时无法加载关键词"
              text="请稍后重试。"
            />
          ) : keywords.length === 0 ? (
            <StatePanel title="暂无关键词" text="可使用右侧文本导入或上方 Excel 导入。" />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] text-left text-sm">
                  <thead className="bg-surface-subtle text-ink-500">
                    <tr>
                      <th className="w-12 p-4">
                        <input
                          aria-label="选择当前页全部关键词"
                          checked={allCurrentPageSelected}
                          disabled={!canWrite}
                          onChange={(event) => toggleCurrentPage(event.currentTarget.checked)}
                          type="checkbox"
                        />
                      </th>
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
                    {keywords.map((keyword) => (
                      <tr className="border-t border-line" key={keyword.id}>
                        <td className="p-4">
                          <input
                            aria-label={`选择关键词 ${keyword.term}`}
                            checked={allFilteredSelected || selectedIds.has(keyword.id)}
                            disabled={!canWrite}
                            onChange={(event) =>
                              toggleKeywordSelection(keyword.id, event.currentTarget.checked)
                            }
                            type="checkbox"
                          />
                        </td>
                        <td className="p-4 font-medium text-ink-950">{keyword.term}</td>
                        <td className="p-4">{keyword.intents.map(intentLabel).join('、')}</td>
                        <td className="p-4">{keyword.priority}</td>
                        <td className="p-4">{keyword.synonyms.join('、') || '—'}</td>
                        <td className="p-4">
                          {keyword.platform_scope.map(platformLabel).join('、')}
                        </td>
                        <td className="p-4">{keyword.status === 'active' ? '启用' : '禁用'}</td>
                        <td className="p-4">
                          {canWrite ? (
                            <div className="flex gap-3">
                              <button
                                className="text-brand-700"
                                onClick={() => {
                                  setBulkEditing(false);
                                  setEditing(keyword);
                                }}
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
              </div>
              <nav
                aria-label="关键词分页"
                className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm"
              >
                <span className="text-ink-500">
                  共 {totalCount} 个 · 第 {page}/{totalPages} 页 · 每页 {KEYWORDS_PER_PAGE} 个
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    className="rounded-control border border-line px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={page <= 1}
                    onClick={() => moveToPage(Math.max(1, page - 1))}
                    type="button"
                  >
                    上一页
                  </button>
                  <form className="flex items-center gap-2" onSubmit={submitPageJump}>
                    <label className="flex items-center gap-2 text-ink-700">
                      跳至
                      <input
                        aria-label="跳转页码"
                        className="w-20 rounded-control border border-line px-2 py-1.5"
                        max={totalPages}
                        min="1"
                        onChange={(event) => setPageInput(event.currentTarget.value)}
                        type="number"
                        value={pageInput}
                      />
                      页
                    </label>
                    <button
                      className="rounded-control border border-line px-3 py-1.5"
                      type="submit"
                    >
                      跳转
                    </button>
                  </form>
                  <button
                    className="rounded-control border border-line px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={page >= totalPages}
                    onClick={() => moveToPage(Math.min(totalPages, page + 1))}
                    type="button"
                  >
                    下一页
                  </button>
                </div>
              </nav>
            </>
          )}
        </section>
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
            <IntentCheckboxes defaultValues={['commercial']} legend="搜索意图" />
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
              分隔：关键词、意图、优先级、同义词、平台、状态；多个意图使用 | 分隔。
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
          {bulkEditing && selectedCount > 0 ? (
            <BulkEditKeywordForm
              busy={busy}
              count={selectedCount}
              onCancel={() => setBulkEditing(false)}
              onSubmit={submitBulkEdit}
            />
          ) : null}
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
    </>
  );
}

function KeywordSpreadsheetImport({
  canWrite,
  keywordSetId,
  onComplete,
}: {
  readonly canWrite: boolean;
  readonly keywordSetId: string;
  readonly onComplete: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [sheetName, setSheetName] = useState('关键词库');
  const [job, setJob] = useState<KeywordImportJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setFile(null);
    setJob(null);
    setMessage(null);
  }, [keywordSetId]);

  useEffect(() => {
    if (!job || !['queued', 'running'].includes(job.status)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void getKeywordImport(keywordSetId, job.id, controller.signal)
        .then((next) => {
          setJob(next);
          if (next.status === 'succeeded') onComplete();
          if (next.status === 'failed') setMessage(next.error?.message ?? '关键词导入失败。');
        })
        .catch(() => {
          if (!controller.signal.aborted) setMessage('暂时无法读取导入进度。');
        });
    }, 1_500);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [job, keywordSetId, onComplete]);

  async function preflight() {
    if (!file) {
      setMessage('请选择 XLSX 文件。');
      return;
    }
    if (
      file.size === 0 ||
      file.size > 25 * 1_024 * 1_024 ||
      !file.name.toLowerCase().endsWith('.xlsx')
    ) {
      setMessage('文件必须是非空 XLSX，且不能超过 25 MiB。');
      return;
    }
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await preflightKeywordImport(keywordSetId, file, sheetName, csrf);
      setJob(result);
      setMessage(
        `预检完成：${result.candidate_count} 个主关键词，折叠 ${result.folded_row_count} 个词序变体。`,
      );
    } catch (error) {
      setMessage(
        error instanceof KeywordSetRequestError && error.status === 422
          ? '无法解析文件。请确认工作表包含关键词、搜索意图和建议页面类型表头。'
          : '预检失败，请稍后重试。',
      );
    } finally {
      setBusy(false);
    }
  }

  async function commit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!job || job.status !== 'preflight_ready') return;
    const data = new FormData(event.currentTarget);
    const selectedSourceIntents = data.getAll('import_source_intent') as KeywordSourceIntent[];
    const selectedPageTypes = data.getAll('import_page_type') as KeywordSuggestedPageType[];
    const platformScope = data.getAll('import_platform') as PlatformCode[];
    if (selectedSourceIntents.length === 0 || selectedPageTypes.length === 0) {
      setMessage('至少选择一种原始搜索意图和一种页面类型。');
      return;
    }
    if (platformScope.length === 0) {
      setMessage('至少选择一个适用平台。');
      return;
    }
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const queued = await commitKeywordImport(
        keywordSetId,
        job.id,
        {
          platformScope,
          priority: Number(data.get('import_priority')),
          selectedPageTypes,
          selectedSourceIntents,
          status: data.get('import_activate') === 'on' ? 'active' : 'disabled',
        },
        csrf,
      );
      setJob(queued);
      setMessage(`已提交后台导入，共选择 ${queued.selected_count} 个主关键词。`);
    } catch (error) {
      setMessage(
        error instanceof KeywordSetRequestError && error.status === 422
          ? '当前筛选没有可导入候选，或导入选项不合法。'
          : '提交导入失败，请稍后重试。',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-5 rounded-2xl border border-line bg-white p-5 shadow-panel">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold text-ink-950">从 Excel 导入结构化关键词库</h2>
          <p className="mt-1 text-sm leading-6 text-ink-500">
            先预检并折叠可验证的词序变体，再按意图和页面类型确认导入。默认导入为禁用。
          </p>
        </div>
        {job ? (
          <span className="rounded-full bg-surface-subtle px-3 py-1 text-xs text-ink-700">
            {importStatusLabel(job.status)}
          </span>
        ) : null}
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-[1fr_240px_auto] md:items-end">
        <label className="text-sm text-ink-700">
          XLSX 文件
          <input
            accept=".xlsx"
            className={`${controlClass} py-2`}
            onChange={(event) => {
              setFile(event.currentTarget.files?.[0] ?? null);
              setJob(null);
            }}
            type="file"
          />
        </label>
        <label className="text-sm text-ink-700">
          工作表
          <input
            className={controlClass}
            onChange={(event) => setSheetName(event.currentTarget.value)}
            value={sheetName}
          />
        </label>
        <button
          className={primaryButton}
          disabled={busy || !canWrite || !file}
          onClick={() => void preflight()}
          type="button"
        >
          {busy ? '正在检查…' : '预检文件'}
        </button>
      </div>

      {job ? (
        <div className="mt-5 border-t border-line pt-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <ImportMetric label="原始行" value={job.total_row_count} />
            <ImportMetric label="主关键词" value={job.candidate_count} />
            <ImportMetric label="折叠变体" value={job.folded_row_count} />
            <ImportMetric label="无效行" value={job.invalid_row_count} />
            <ImportMetric label="已写入" value={job.imported_count} />
          </div>
          {job.status === 'preflight_ready' ? (
            <form className="mt-5 grid gap-5 lg:grid-cols-2" onSubmit={commit}>
              <ImportChoices
                counts={job.summary.source_intents}
                legend="导入哪些原始搜索意图"
                name="import_source_intent"
              />
              <ImportChoices
                counts={job.summary.page_types}
                legend="导入哪些建议页面类型"
                name="import_page_type"
              />
              <fieldset>
                <legend className="text-sm font-medium text-ink-700">适用平台</legend>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {PLATFORM_OPTIONS.map(([code, label]) => (
                    <label className="flex items-center gap-2 text-sm" key={code}>
                      <input
                        defaultChecked={code === 'official_site'}
                        name="import_platform"
                        type="checkbox"
                        value={code}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div>
                <label className="block text-sm text-ink-700">
                  默认优先级
                  <input
                    className={controlClass}
                    defaultValue="50"
                    max="100"
                    min="0"
                    name="import_priority"
                    type="number"
                  />
                </label>
                <label className="mt-4 flex items-start gap-2 text-sm text-ink-700">
                  <input className="mt-1" name="import_activate" type="checkbox" />
                  <span>
                    导入后立即启用
                    <span className="block text-xs text-red-700">
                      仅勾选后进入自动选题；大批量关键词建议先保持禁用。
                    </span>
                  </span>
                </label>
              </div>
              <div className="lg:col-span-2">
                <button className={primaryButton} disabled={busy} type="submit">
                  确认并开始后台导入
                </button>
              </div>
            </form>
          ) : (
            <p className="mt-4 text-sm text-ink-700">
              {job.status === 'failed'
                ? (job.error?.message ?? '导入失败。')
                : job.status === 'succeeded'
                  ? `导入完成，共写入或更新 ${job.imported_count} 个主关键词。`
                  : `后台处理中：${job.imported_count} / ${job.selected_count}`}
            </p>
          )}
        </div>
      ) : null}
      <div aria-live="polite" className="mt-3 min-h-5 text-sm">
        {message ? <p role="status">{message}</p> : null}
      </div>
    </section>
  );
}

function ImportMetric({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div className="rounded-xl bg-surface-subtle p-3">
      <p className="text-xs text-ink-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-ink-950">{value.toLocaleString('zh-CN')}</p>
    </div>
  );
}

function ImportChoices({
  counts,
  legend,
  name,
}: {
  readonly counts: readonly { readonly count: number; readonly label: string }[];
  readonly legend: string;
  readonly name: string;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-medium text-ink-700">{legend}</legend>
      <div className="mt-2 max-h-52 space-y-2 overflow-auto rounded-control border border-line p-3">
        {counts.map((item) => (
          <label className="flex items-center justify-between gap-3 text-sm" key={item.label}>
            <span className="flex items-center gap-2">
              <input defaultChecked name={name} type="checkbox" value={item.label} />
              {item.label}
            </span>
            <span className="text-xs text-ink-500">{item.count.toLocaleString('zh-CN')}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function importStatusLabel(status: KeywordImportJob['status']): string {
  return (
    {
      failed: '导入失败',
      preflight_ready: '等待确认',
      queued: '等待后台处理',
      running: '正在导入',
      succeeded: '导入完成',
    } as const
  )[status];
}

function BulkEditKeywordForm({
  busy,
  count,
  onCancel,
  onSubmit,
}: {
  readonly busy: boolean;
  readonly count: number;
  readonly onCancel: () => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form
      className="rounded-2xl border border-brand-200 bg-white p-5 shadow-panel"
      onSubmit={onSubmit}
    >
      <h2 className="font-semibold text-ink-950">批量编辑 {count} 个关键词</h2>
      <p className="mt-1 text-xs leading-5 text-ink-500">
        只会修改已勾选的字段；关键词名称和同义词仍需逐条编辑。
      </p>
      <fieldset className="mt-4">
        <legend className="text-sm font-medium text-ink-700">
          <label className="flex items-center gap-2">
            <input name="apply_intents" type="checkbox" />
            修改搜索意图
          </label>
        </legend>
        <div className="mt-2 grid gap-2 pl-6">
          {INTENT_OPTIONS.map(([intent, label]) => (
            <label className="flex items-center gap-2 text-sm" key={intent}>
              <input name="bulk_intents" type="checkbox" value={intent} />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-4">
        <label className="flex items-center gap-2 text-sm font-medium text-ink-700">
          <input name="apply_priority" type="checkbox" />
          修改优先级
        </label>
        <input
          aria-label="批量优先级"
          className={controlClass}
          defaultValue="80"
          max="100"
          min="0"
          name="bulk_priority"
          type="number"
        />
      </div>
      <fieldset className="mt-4">
        <legend className="text-sm font-medium text-ink-700">
          <label className="flex items-center gap-2">
            <input name="apply_platforms" type="checkbox" />
            修改适用平台
          </label>
        </legend>
        <div className="mt-2 grid grid-cols-2 gap-2 pl-6">
          {PLATFORM_OPTIONS.map(([code, label]) => (
            <label className="flex items-center gap-2 text-sm" key={code}>
              <input name="bulk_platforms" type="checkbox" value={code} />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-4">
        <label className="flex items-center gap-2 text-sm font-medium text-ink-700">
          <input name="apply_status" type="checkbox" />
          修改状态
        </label>
        <select aria-label="批量状态" className={controlClass} name="bulk_status">
          <option value="active">启用</option>
          <option value="disabled">禁用</option>
        </select>
      </div>
      <div className="mt-4 flex gap-3">
        <button className={primaryButton} disabled={busy} type="submit">
          保存批量修改
        </button>
        <button className={secondaryButton} onClick={onCancel} type="button">
          取消
        </button>
      </div>
    </form>
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
      intents: data.getAll('intents'),
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
      <IntentCheckboxes defaultValues={keyword.intents} legend="搜索意图" />
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
    const [term, intents, priority, synonyms = '', platforms = '', status = 'active', ...rest] =
      columns.length === 1
        ? [columns[0], 'commercial', '80', '', 'official_site', 'active']
        : columns;
    if (rest.length > 0) throw new Error(`第 ${index + 1} 行字段数超过 6 个。`);
    const parsed = KeywordInputSchema.safeParse({
      intents: splitPipe(intents),
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
    intents: keyword.intents,
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
function intentLabel(intent: KeywordIntent) {
  return INTENT_OPTIONS.find(([value]) => value === intent)?.[1] ?? intent;
}
function isKeywordIntent(value: string): value is KeywordIntent {
  return INTENT_OPTIONS.some(([intent]) => intent === value);
}
function isPlatformCode(value: string): value is PlatformCode {
  return PLATFORM_OPTIONS.some(([code]) => code === value);
}
function IntentCheckboxes({
  defaultValues,
  legend,
}: {
  readonly defaultValues: readonly KeywordIntent[];
  readonly legend: string;
}) {
  return (
    <fieldset className="mt-4">
      <legend className="text-sm text-ink-700">{legend}</legend>
      <div className="mt-2 grid gap-2">
        {INTENT_OPTIONS.map(([intent, label]) => (
          <label className="flex items-center gap-2 text-sm" key={intent}>
            <input
              defaultChecked={defaultValues.includes(intent)}
              name="intents"
              type="checkbox"
              value={intent}
            />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
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
