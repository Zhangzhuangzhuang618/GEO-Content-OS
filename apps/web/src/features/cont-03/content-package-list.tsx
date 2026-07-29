'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import {
  ContentPackageListRequestError,
  copyContentPackage,
  listContentPackages,
  loadCurrentUserId,
} from './content-package-list-api';
import {
  ContentPackageStatusSchema,
  PlatformCodeSchema,
  type ContentPackageStatus,
  type PackageFilters,
  type PackageListItem,
  type PlatformCode,
} from './content-package-list.schema';

const COPY_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'content_editor']);
const COST_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'analyst']);

export function ContentPackageList() {
  const [filters, setFilters] = useState<PackageFilters>(readFilters);
  const [items, setItems] = useState<PackageListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [canCopy, setCanCopy] = useState(false);
  const [currentUserId, setCurrentUserId] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'permission' | 'rate_limited'>(
    'loading',
  );
  const [retryAfterSeconds, setRetryAfterSeconds] = useState<number | null>(null);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ readonly id?: string; readonly text: string } | null>(
    null,
  );

  const load = useCallback(async (next: PackageFilters, signal?: AbortSignal) => {
    setState('loading');
    setRetryAfterSeconds(null);
    try {
      const tenants = await listAvailableTenants(signal);
      const role = tenants.find((tenant) => tenant.is_active)?.role_code;
      if (!role) {
        setState('permission');
        return;
      }
      const [page, userId] = await Promise.all([
        listContentPackages(next, COST_ROLES.has(role), signal),
        loadCurrentUserId(signal).catch(() => ''),
      ]);
      if (signal?.aborted) return;
      setCanCopy(COPY_ROLES.has(role));
      setCurrentUserId(userId);
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setState('ready');
    } catch (error) {
      if (signal?.aborted) return;
      if (errorStatus(error) === 429) {
        setRetryAfterSeconds(
          error instanceof ContentPackageListRequestError ? error.retryAfterSeconds : null,
        );
        setState('rate_limited');
        return;
      }
      setState(isAccessError(error) ? 'permission' : 'error');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(filters, controller.signal);
    return () => controller.abort();
  }, [filters, load]);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const platform = PlatformCodeSchema.safeParse(data.get('platform_code'));
    const status = ContentPackageStatusSchema.safeParse(data.get('status'));
    const search = String(data.get('search') ?? '').trim();
    const next: PackageFilters = {
      ...(platform.success ? { platformCode: platform.data } : {}),
      ...(search ? { search } : {}),
      ...(status.success ? { status: status.data } : {}),
    };
    setFilters(next);
    writeFilters(next);
  }

  function changePage(cursor?: string) {
    const next = { ...filters, ...(cursor ? { cursor } : {}) };
    if (!cursor) delete next.cursor;
    setFilters(next);
    writeFilters(next);
  }

  async function copy(item: PackageListItem) {
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage({ text: '安全令牌尚未就绪，请刷新页面后重试。' });
      return;
    }
    setCopyingId(item.package.id);
    setMessage(null);
    try {
      const created = await copyContentPackage(item.package, csrf);
      setMessage({ id: created.id, text: '新内容任务已创建。' });
    } catch {
      setMessage({ text: '复制失败，请确认当前角色仍有内容生产权限。' });
    } finally {
      setCopyingId(null);
    }
  }

  if (state === 'permission')
    return <StatePanel title="无权查看当前内容" text="当前企业或工作空间未授权访问。" />;
  if (state === 'rate_limited')
    return (
      <StatePanel
        title="请求过于频繁"
        text={
          retryAfterSeconds === null
            ? '请稍后刷新页面。'
            : `请等待约 ${retryAfterSeconds} 秒后刷新页面。`
        }
      />
    );
  if (state === 'error')
    return <StatePanel title="暂时无法加载内容" text="请刷新页面或稍后再试。" />;

  const visibleItems = filters.search
    ? items.filter((item) => item.briefTitle.toLowerCase().includes(filters.search!.toLowerCase()))
    : items;

  return (
    <section className="mt-8">
      <details
        className="group overflow-hidden rounded-2xl border border-line bg-white shadow-panel"
        key={`filter-panel-${filterFormKey(filters)}`}
        open={hasActiveFilters(filters) ? true : undefined}
      >
        <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 px-5 py-4">
          <div>
            <p className="font-semibold text-ink-950">查找和筛选内容</p>
            <p className="mt-1 text-sm text-ink-500">
              {hasActiveFilters(filters) ? '筛选条件已生效。' : '按主题、进度或平台缩小范围。'}
            </p>
          </div>
          <span className="text-sm font-semibold text-brand-700 group-open:hidden">展开</span>
          <span className="hidden text-sm font-semibold text-brand-700 group-open:inline">
            收起
          </span>
        </summary>
        <form
          aria-label="内容筛选"
          className="border-t border-line p-5"
          key={filterFormKey(filters)}
          onSubmit={applyFilters}
        >
          <div className="grid gap-4 md:grid-cols-[minmax(240px,1fr)_220px_220px_auto]">
            <TextField
              defaultValue={filters.search}
              label="搜索主题"
              name="search"
              placeholder="例如：广州搬家公司怎么选"
            />
            <SelectField
              label="当前进度"
              name="status"
              options={STATUS_OPTIONS}
              value={filters.status}
            />
            <SelectField
              label="平台"
              name="platform_code"
              options={PLATFORM_OPTIONS}
              value={filters.platformCode}
            />
            <div className="flex items-end gap-3">
              <button className={primaryButton} type="submit">
                查找
              </button>
              <button
                className={secondaryButton}
                onClick={() => {
                  setFilters({});
                  writeFilters({});
                }}
                type="button"
              >
                重置
              </button>
            </div>
          </div>
        </form>
      </details>

      {message ? (
        <p
          aria-live="polite"
          className="mt-4 rounded-control bg-brand-50 px-4 py-3 text-sm text-brand-700"
        >
          {message.text}{' '}
          {message.id ? (
            <Link className="text-brand-700" href={`/cont-04?id=${message.id}`}>
              打开新任务
            </Link>
          ) : null}
        </p>
      ) : null}

      {state === 'loading' ? (
        <StatePanel title="正在加载内容" text="正在整理主题和各平台进度。" />
      ) : items.length === 0 && !hasActiveFilters(filters) ? (
        <EmptyState />
      ) : visibleItems.length === 0 ? (
        <StatePanel title="没有找到匹配内容" text="换个关键词或重置筛选条件后再试。" />
      ) : (
        <div className="mt-5 grid gap-4">
          {visibleItems.map((item) => (
            <ContentCard
              canCopy={canCopy}
              copying={copyingId === item.package.id}
              currentUserId={currentUserId}
              item={item}
              key={item.package.id}
              onCopy={copy}
            />
          ))}
        </div>
      )}

      <nav aria-label="内容任务分页" className="mt-5 flex flex-wrap gap-3">
        {filters.cursor ? (
          <button className={secondaryButton} onClick={() => changePage()} type="button">
            返回最新内容
          </button>
        ) : null}
        {nextCursor ? (
          <button className={primaryButton} onClick={() => changePage(nextCursor)} type="button">
            查看更早内容
          </button>
        ) : null}
      </nav>
    </section>
  );
}

function ContentCard({
  canCopy,
  copying,
  currentUserId,
  item,
  onCopy,
}: {
  readonly canCopy: boolean;
  readonly copying: boolean;
  readonly currentUserId: string;
  readonly item: PackageListItem;
  readonly onCopy: (item: PackageListItem) => Promise<void>;
}) {
  const scored = item.variants.flatMap((variant) =>
    variant.quality_score === null ? [] : [variant.quality_score],
  );
  const produced = item.variants.filter((variant) => !UNPRODUCED.has(variant.status)).length;
  const progress =
    item.variants.length === 0 ? 0 : Math.round((produced / item.variants.length) * 100);
  return (
    <article className="rounded-2xl border border-line bg-white p-5 shadow-panel sm:p-6">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <span className={statusClass(item.package.status)}>
              {statusLabel(item.package.status)}
            </span>
            <span className="text-xs text-ink-500">
              {item.package.created_by === currentUserId ? '由你创建' : '由团队成员创建'}
            </span>
            <span className="text-xs text-ink-500">{formatUpdatedAt(item.package.updated_at)}</span>
          </div>

          <h2 className="mt-3 text-xl font-semibold tracking-tight text-ink-950">
            <Link className="hover:text-brand-700" href={`/cont-04?id=${item.package.id}`}>
              {item.briefTitle}
            </Link>
          </h2>
          <p className="mt-2 text-sm text-ink-500">{nextStepText(item.package.status)}</p>

          <div className="mt-5">
            <div className="flex items-center justify-between gap-4 text-sm">
              <span className="font-medium text-ink-700">平台内容进度</span>
              <span className="text-ink-500">
                {item.detailState === 'ready'
                  ? `已生成 ${produced}/${item.variants.length}`
                  : item.detailState === 'loading'
                    ? '正在读取'
                    : '暂不可用'}
              </span>
            </div>
            <div
              aria-label={`平台内容进度 ${progress}%`}
              className="mt-2 h-2 overflow-hidden rounded-full bg-surface-subtle"
              role="progressbar"
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={progress}
            >
              <div className="h-full rounded-full bg-brand-600" style={{ width: `${progress}%` }} />
            </div>
            <ul aria-label="平台状态" className="mt-3 flex flex-wrap gap-2">
              {item.variants.map((variant) => (
                <li className={platformStatusClass(variant.status)} key={variant.id}>
                  {platformLabel(variant.platform_code)} · {variantStatusLabel(variant.status)}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="grid shrink-0 grid-cols-2 gap-3 lg:w-72">
          <Summary label="内容质量" value={scored.length ? `${average(scored)} 分` : '待检查'} />
          <Summary label="已结算成本" value={formatCosts(item.costs)} />
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-5">
        <Link className={primaryButton} href={`/cont-04?id=${item.package.id}`}>
          {actionLabel(item.package.status)}
        </Link>
        {canCopy ? (
          <button
            className={secondaryButton}
            disabled={copying}
            onClick={() => void onCopy(item)}
            type="button"
          >
            {copying ? '正在复制' : '复制为新任务'}
          </button>
        ) : null}
      </div>
    </article>
  );
}

function Summary({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-control bg-surface-subtle px-4 py-3">
      <p className="text-xs text-ink-500">{label}</p>
      <p className="mt-1 text-sm font-semibold text-ink-950">{value}</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mt-5 rounded-2xl border border-line bg-white p-10 text-center shadow-panel">
      <h2 className="text-lg font-semibold text-ink-950">还没有创建内容</h2>
      <p className="mt-2 text-sm text-ink-500">
        从一个主题开始，系统会为你生成所选平台的适配内容。
      </p>
      <Link className={`${primaryButton} mt-5`} href="/dash-01#create-content">
        创建第一份内容
      </Link>
    </div>
  );
}

const UNPRODUCED = new Set(['draft', 'generating', 'generation_failed', 'cancelled']);
const PLATFORM_OPTIONS = [
  ['official_site', '官网'],
  ['baijiahao', '百家号'],
  ['toutiao', '头条号'],
  ['zhihu', '知乎'],
  ['xiaohongshu', '小红书'],
  ['wechat_mp', '微信公众号'],
  ['douyin', '抖音'],
] as const satisfies readonly (readonly [PlatformCode, string])[];
const STATUS_OPTIONS = [
  ['draft', '准备生成'],
  ['generating', '正在生成'],
  ['generated', '等待质量检查'],
  ['all_failed', '生成失败'],
  ['editing', '编辑中'],
  ['in_review', '等待审核'],
  ['rejected', '需要修改'],
  ['approved', '审核通过'],
  ['scheduled', '已排期'],
  ['publishing', '发布中'],
  ['publish_failed', '发布失败'],
  ['published', '已发布'],
  ['cancelled', '已取消'],
  ['archived', '已归档'],
] as const satisfies readonly (readonly [ContentPackageStatus, string])[];

function average(values: readonly number[]) {
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}
function formatCosts(costs: PackageListItem['costs']) {
  if (costs === undefined) return '暂不可用';
  if (costs === null) return '仅管理员可见';
  if (costs.length === 0) return '暂无';
  return costs.map((cost) => `${cost.currency} ${(cost.costCents / 100).toFixed(2)}`).join(' / ');
}

function platformLabel(code: PlatformCode) {
  return PLATFORM_OPTIONS.find(([value]) => value === code)?.[1] ?? code;
}
function statusLabel(code: ContentPackageStatus) {
  return STATUS_OPTIONS.find(([value]) => value === code)?.[1] ?? code;
}
function actionLabel(code: ContentPackageStatus) {
  if (['draft', 'all_failed'].includes(code)) return '继续生成';
  if (code === 'generating') return '查看生成进度';
  if (['generated', 'editing', 'rejected'].includes(code)) return '继续完善内容';
  if (code === 'in_review') return '查看审核进度';
  if (['approved', 'scheduled', 'publishing', 'publish_failed'].includes(code))
    return '查看发布进度';
  return '查看内容';
}
function nextStepText(code: ContentPackageStatus) {
  const descriptions: Record<ContentPackageStatus, string> = {
    all_failed: '生成没有成功。打开任务查看原因并重新生成。',
    approved: '内容已通过审核，可以安排发布。',
    archived: '内容已归档，仍可查看历史记录。',
    cancelled: '任务已取消，仍可查看已有内容。',
    draft: '内容任务已经建立，下一步是开始生成平台内容。',
    editing: '内容正在完善中，可以继续编辑并检查质量。',
    generated: '平台内容已经生成，下一步是检查质量并完善内容。',
    generating: '系统正在生成平台内容，可以进入任务查看实时进度。',
    in_review: '内容已经提交审核，正在等待审核结果。',
    publish_failed: '发布没有成功，打开任务查看原因并重试。',
    published: '内容已经完成发布，可以查看各平台交付结果。',
    publishing: '内容正在发送到目标平台。',
    rejected: '审核提出了修改意见，请完善后再次提交。',
    scheduled: '内容已经安排发布时间。',
  };
  return descriptions[code];
}
function statusClass(code: ContentPackageStatus) {
  const base = 'inline-flex rounded-full px-3 py-1 text-xs font-semibold';
  if (['all_failed', 'publish_failed', 'rejected'].includes(code))
    return `${base} bg-red-50 text-red-700`;
  if (['approved', 'published'].includes(code)) return `${base} bg-emerald-50 text-emerald-700`;
  if (['generating', 'publishing', 'in_review'].includes(code))
    return `${base} bg-brand-50 text-brand-700`;
  if (['cancelled', 'archived'].includes(code)) return `${base} bg-slate-100 text-ink-500`;
  return `${base} bg-amber-50 text-amber-800`;
}
function variantStatusLabel(code: string) {
  if (code === 'draft') return '待生成';
  if (['generating', 'publishing'].includes(code)) return '进行中';
  if (['generation_failed', 'quality_failed', 'review_rejected', 'publish_failed'].includes(code))
    return '需处理';
  if (code === 'cancelled') return '已取消';
  return '已生成';
}
function platformStatusClass(code: string) {
  const base = 'rounded-full px-2.5 py-1 text-xs font-medium';
  if (['generation_failed', 'quality_failed', 'review_rejected', 'publish_failed'].includes(code))
    return `${base} bg-red-50 text-red-700`;
  if (['generating', 'publishing'].includes(code)) return `${base} bg-brand-50 text-brand-700`;
  if (['draft', 'cancelled'].includes(code)) return `${base} bg-slate-100 text-ink-500`;
  return `${base} bg-emerald-50 text-emerald-700`;
}
function formatUpdatedAt(value: string) {
  const date = new Date(value);
  const elapsed = Date.now() - date.getTime();
  if (!Number.isFinite(elapsed)) return '更新时间未知';
  if (elapsed < 60 * 1_000) return '刚刚更新';
  if (elapsed < 60 * 60 * 1_000) return `${Math.floor(elapsed / (60 * 1_000))} 分钟前更新`;
  if (elapsed < 24 * 60 * 60 * 1_000)
    return `${Math.floor(elapsed / (60 * 60 * 1_000))} 小时前更新`;
  if (elapsed < 7 * 24 * 60 * 60 * 1_000)
    return `${Math.floor(elapsed / (24 * 60 * 60 * 1_000))} 天前更新`;
  return `${date.toLocaleDateString('zh-CN')} 更新`;
}
function hasActiveFilters(filters: PackageFilters) {
  return Object.values(filters).some(Boolean);
}
function filterFormKey(filters: PackageFilters) {
  return [filters.search ?? '', filters.status ?? '', filters.platformCode ?? ''].join('|');
}
function isAccessError(error: unknown) {
  const status = errorStatus(error);
  return status !== null && [401, 403, 404].includes(status);
}
function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}
function readFilters(): PackageFilters {
  if (typeof window === 'undefined') return {};
  const query = new URLSearchParams(window.location.search);
  const platform = PlatformCodeSchema.safeParse(query.get('platform_code'));
  const status = ContentPackageStatusSchema.safeParse(query.get('status'));
  const createdBy = query.get('created_by');
  const cursor = query.get('cursor');
  const projectId = query.get('project_id');
  const search = query.get('search');
  const workspaceId = query.get('workspace_id');
  return {
    ...(createdBy ? { createdBy } : {}),
    ...(cursor ? { cursor } : {}),
    ...(platform.success ? { platformCode: platform.data } : {}),
    ...(projectId ? { projectId } : {}),
    ...(search ? { search } : {}),
    ...(status.success ? { status: status.data } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  };
}
function writeFilters(filters: PackageFilters) {
  const query = new URLSearchParams();
  if (filters.workspaceId) query.set('workspace_id', filters.workspaceId);
  if (filters.projectId) query.set('project_id', filters.projectId);
  if (filters.createdBy) query.set('created_by', filters.createdBy);
  if (filters.search) query.set('search', filters.search);
  if (filters.status) query.set('status', filters.status);
  if (filters.platformCode) query.set('platform_code', filters.platformCode);
  if (filters.cursor) query.set('cursor', filters.cursor);
  window.history.replaceState(null, '', query.size ? `/cont-03?${query}` : '/cont-03');
}
function readCookie(name: string) {
  const entry = document.cookie.split('; ').find((value) => value.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
}
function TextField({
  defaultValue,
  label,
  name,
  placeholder,
}: {
  readonly defaultValue?: string | undefined;
  readonly label: string;
  readonly name: string;
  readonly placeholder?: string | undefined;
}) {
  return (
    <label className="text-sm text-ink-700">
      {label}
      <input
        className={controlClass}
        defaultValue={defaultValue ?? ''}
        name={name}
        placeholder={placeholder}
        type="search"
      />
    </label>
  );
}
function SelectField({
  label,
  name,
  options,
  value,
}: {
  readonly label: string;
  readonly name: string;
  readonly options: readonly (readonly [string, string])[];
  readonly value?: string | undefined;
}) {
  return (
    <label className="text-sm text-ink-700">
      {label}
      <select className={controlClass} defaultValue={value ?? ''} name={name}>
        <option value="">全部</option>
        {options.map(([code, text]) => (
          <option key={code} value={code}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}
function StatePanel({ title, text }: { readonly title: string; readonly text: string }) {
  return (
    <div className="mt-5 rounded-2xl border border-line bg-white p-8 text-center shadow-panel">
      <h2 className="font-semibold text-ink-950">{title}</h2>
      <p className="mt-2 text-sm text-ink-500">{text}</p>
    </div>
  );
}
const controlClass =
  'mt-2 h-11 w-full rounded-control border border-line bg-white px-3 text-sm text-ink-950 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-100';
const primaryButton =
  'inline-flex h-11 items-center justify-center rounded-control bg-brand-600 px-4 text-sm font-semibold text-white disabled:opacity-50';
const secondaryButton =
  'h-11 rounded-control border border-line px-4 text-sm font-semibold text-ink-700 disabled:opacity-50';
