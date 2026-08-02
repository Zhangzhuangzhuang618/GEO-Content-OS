'use client';

import Image from 'next/image';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { listProjects } from '../know-02/source-upload-api';
import type { ProjectChoice } from '../know-02/source-upload.schema';
import {
  getBaijiahaoBrowserSession,
  listBaijiahaoAutomationPolicies,
  saveBaijiahaoAutomationPolicy,
  startBaijiahaoBrowserLogin,
} from './platform-account-api';
import type {
  BaijiahaoAutomationPolicy,
  BaijiahaoBrowserLogin,
  BaijiahaoBrowserSession,
  PlatformAccount,
} from './platform-account.schema';

export function BaijiahaoAutomationPanel({
  account,
  onClose,
}: {
  readonly account: PlatformAccount;
  readonly onClose: () => void;
}) {
  const [projects, setProjects] = useState<ProjectChoice[]>([]);
  const [policies, setPolicies] = useState<readonly BaijiahaoAutomationPolicy[]>([]);
  const [projectId, setProjectId] = useState('');
  const [session, setSession] = useState<BaijiahaoBrowserSession | null>(null);
  const [login, setLogin] = useState<BaijiahaoBrowserLogin | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const selected = useMemo(
    () => policies.find((policy) => policy.project_id === projectId),
    [policies, projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    void Promise.all([
      listProjects(account.workspace_id, controller.signal),
      listBaijiahaoAutomationPolicies(account.id, controller.signal),
      getBaijiahaoBrowserSession(account.id, controller.signal).catch(() => null),
    ])
      .then(([nextProjects, nextPolicies, nextSession]) => {
        if (controller.signal.aborted) return;
        setProjects(nextProjects);
        setPolicies(nextPolicies);
        setProjectId(nextPolicies[0]?.project_id ?? nextProjects[0]?.id ?? '');
        setSession(nextSession ?? nextPolicies[0]?.browser_session ?? null);
        setState('ready');
      })
      .catch(() => {
        if (!controller.signal.aborted) setState('error');
      });
    return () => controller.abort();
  }, [account.id, account.workspace_id]);

  useEffect(() => {
    if (session?.status !== 'qr_ready') return;
    const timer = setInterval(() => {
      void getBaijiahaoBrowserSession(account.id)
        .then((next) => {
          setSession(next);
          if (next.status === 'authenticated') {
            setLogin(null);
            setMessage('扫码登录已确认，可以开启百家号自动化。');
          }
        })
        .catch(() => undefined);
    }, 3_000);
    return () => clearInterval(timer);
  }, [account.id, session?.status]);

  async function beginLogin() {
    const csrf = readCookie('geo_csrf');
    if (!csrf) return setMessage('安全令牌尚未就绪，请刷新页面后重试。');
    setMessage(null);
    try {
      const next = await startBaijiahaoBrowserLogin(account, csrf, session?.status === 'reauth');
      setLogin(next);
      setSession(next);
      setMessage(
        next.status === 'authenticated'
          ? '当前浏览器会话仍然有效。'
          : '请使用百度 App 扫码。二维码仅在本页显示，不会写入日志或数据库。',
      );
    } catch {
      setMessage('无法启动扫码登录。请检查浏览器 Worker 和内部网关配置。');
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const csrf = readCookie('geo_csrf');
    if (!csrf || !projectId) return setMessage('缺少项目或安全令牌，请刷新后重试。');
    const form = new FormData(event.currentTarget);
    const target = Number(form.get('daily_target_count'));
    const candidateLimit = Number(form.get('daily_candidate_limit'));
    const schedules = String(form.get('daily_schedule_times') ?? '')
      .split(',')
      .map(normalizeTime)
      .filter((value): value is string => value !== null);
    if (
      !Number.isInteger(target) ||
      target < 1 ||
      target > 10 ||
      !Number.isInteger(candidateLimit) ||
      candidateLimit < target ||
      candidateLimit > 30 ||
      schedules.length !== target
    ) {
      return setMessage('每日目标为 1～10，候选上限不得低于目标；发布时间数量必须与目标一致。');
    }
    const enabled = form.get('enabled') === 'on';
    const sourceMode =
      form.get('source_mode') === 'independent' ? 'independent' : 'official_site_derived';
    if (enabled && session?.status !== 'authenticated') {
      return setMessage('请先完成扫码登录，再开启自动化。');
    }
    setState('saving');
    setMessage(null);
    try {
      const saved = await saveBaijiahaoAutomationPolicy(
        account.id,
        {
          dailyCandidateLimit: candidateLimit,
          dailyEnabled: enabled && form.get('daily_enabled') === 'on',
          dailyGenerationTime:
            normalizeTime(String(form.get('daily_generation_time'))) ?? '00:30:00',
          dailyScheduleTimes: schedules,
          dailyTargetCount: target,
          enabled,
          ...(selected ? { expectedVersion: selected.version } : {}),
          independentFallbackEnabled:
            sourceMode === 'official_site_derived' &&
            form.get('independent_fallback_enabled') === 'on',
          projectId,
          sourceMode,
        },
        csrf,
      );
      setPolicies((current) => [
        ...current.filter((policy) => policy.project_id !== saved.project_id),
        saved,
      ]);
      setMessage(saved.enabled ? '百家号自动化策略已开启。' : '百家号自动化策略已保存但未开启。');
      setState('ready');
    } catch {
      setMessage('保存失败。账号、项目、登录态或策略版本可能已经变化。');
      setState('ready');
    }
  }

  return (
    <section className="mt-5 rounded-2xl border border-brand-200 bg-white p-5 shadow-panel sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-ink-950">百家号自动生成与浏览器发布</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-ink-500">
            默认复用已成功发布的官网文章事实和证据，只执行一次百家号定向改写；不合适的内容会跳过，百家号失败不会改变官网状态。
          </p>
        </div>
        <button className={secondaryButton} onClick={onClose} type="button">
          关闭
        </button>
      </div>
      {state === 'loading' ? (
        <p className="mt-5 text-sm text-ink-500">正在读取策略与登录态…</p>
      ) : null}
      {state === 'error' ? (
        <p className="mt-5 text-sm text-red-700">暂时无法读取百家号配置。</p>
      ) : null}
      {state === 'ready' || state === 'saving' ? (
        <>
          <div className="mt-5 rounded-xl border border-line bg-surface-subtle p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold text-ink-900">托管浏览器登录</p>
                <p className="mt-1 text-sm text-ink-600">
                  状态：{sessionLabel(session?.status ?? 'login_required')}
                </p>
              </div>
              <button className={primaryButton} onClick={() => void beginLogin()} type="button">
                {session?.status === 'reauth' ? '重新扫码' : '扫码登录'}
              </button>
            </div>
            {login?.qr_image_data_url ? (
              <div className="mt-4 flex flex-wrap items-center gap-5">
                <Image
                  alt="百家号扫码登录二维码"
                  className="h-72 w-72 rounded-lg border border-line bg-white p-3 [image-rendering:pixelated] sm:h-80 sm:w-80"
                  height={320}
                  src={login.qr_image_data_url}
                  unoptimized
                  width={320}
                />
                <p className="max-w-md text-sm leading-6 text-ink-600">
                  二维码过期后点击“扫码登录”刷新。系统不保存百度账号密码；登录 Cookie 加密保存。
                </p>
              </div>
            ) : null}
          </div>
          <form
            className="mt-5"
            key={`${projectId}:${selected?.version ?? 0}`}
            onSubmit={(event) => void save(event)}
          >
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              <label className={labelClass}>
                应用项目
                <select
                  className={controlClass}
                  onChange={(event) => setProjectId(event.target.value)}
                  value={projectId}
                >
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className={labelClass}>
                内容来源
                <select
                  className={controlClass}
                  defaultValue={selected?.source_mode ?? 'official_site_derived'}
                  name="source_mode"
                >
                  <option value="official_site_derived">官网发布成功后定向改写（默认）</option>
                  <option value="independent">独立使用项目知识库生成</option>
                </select>
              </label>
              <label className={labelClass}>
                每日开始时间
                <input
                  className={controlClass}
                  defaultValue={(selected?.daily_generation_time ?? '00:30:00').slice(0, 5)}
                  name="daily_generation_time"
                  type="time"
                />
              </label>
              <label className={labelClass}>
                每日合格目标
                <input
                  className={controlClass}
                  defaultValue={selected?.daily_target_count ?? 1}
                  max={10}
                  min={1}
                  name="daily_target_count"
                  type="number"
                />
              </label>
              <label className={labelClass}>
                每日候选上限
                <input
                  className={controlClass}
                  defaultValue={selected?.daily_candidate_limit ?? 3}
                  max={30}
                  min={1}
                  name="daily_candidate_limit"
                  type="number"
                />
              </label>
              <label className={labelClass}>
                发布时间（逗号分隔）
                <input
                  className={controlClass}
                  defaultValue={(selected?.daily_schedule_times ?? ['10:00:00'])
                    .map((value) => value.slice(0, 5))
                    .join(',')}
                  name="daily_schedule_times"
                />
              </label>
            </div>
            <div className="mt-5 space-y-3 text-sm text-ink-700">
              <Check
                name="enabled"
                defaultChecked={selected?.enabled ?? false}
                text="开启百家号自动化"
              />
              <Check
                name="daily_enabled"
                defaultChecked={selected?.daily_enabled ?? false}
                text="启用每日计划"
              />
              <Check
                name="independent_fallback_enabled"
                defaultChecked={selected?.independent_fallback_enabled ?? false}
                text="派生模式当天无合适官网文章时允许独立补位（默认关闭）"
              />
            </div>
            <div className="mt-5 rounded-xl bg-amber-50 p-4 text-sm leading-6 text-amber-950">
              冻结门槛：总分 85、事实 90、品牌 90、可读与安全 85、问题覆盖 80、平台适配
              80；任一阻断不发布，最多重写 3 次。来源相似度上限 0.82。
            </div>
            {selected?.today_batch ? <BatchSummary policy={selected} /> : null}
            <div aria-live="polite" className="mt-4 min-h-6 text-sm text-ink-700">
              {message}
            </div>
            <button
              className={`${primaryButton} mt-2`}
              disabled={state === 'saving' || projects.length === 0}
              type="submit"
            >
              {state === 'saving' ? '正在保存…' : '保存百家号策略'}
            </button>
          </form>
        </>
      ) : null}
    </section>
  );
}

function Check({
  name,
  text,
  defaultChecked,
}: {
  readonly name: string;
  readonly text: string;
  readonly defaultChecked: boolean;
}) {
  return (
    <label className="flex items-start gap-3">
      <input className="mt-1" defaultChecked={defaultChecked} name={name} type="checkbox" />
      <span>{text}</span>
    </label>
  );
}

function BatchSummary({ policy }: { readonly policy: BaijiahaoAutomationPolicy }) {
  const batch = policy.today_batch;
  if (!batch) return null;
  return (
    <div className="mt-5 grid gap-3 rounded-xl border border-line p-4 text-sm sm:grid-cols-3">
      <p>今日候选：{batch.attempted_count}</p>
      <p>处理中：{batch.in_progress_count}</p>
      <p>已排期：{batch.scheduled_count}</p>
      <p>已发布：{batch.published_count}</p>
      <p>已跳过：{batch.skipped_count}</p>
      <p>需人工：{batch.manual_required_count}</p>
    </div>
  );
}

function normalizeTime(value: string): string | null {
  const trimmed = value.trim();
  if (/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(trimmed)) return `${trimmed}:00`;
  if (/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u.test(trimmed)) return trimmed;
  return null;
}

function sessionLabel(status: BaijiahaoBrowserSession['status']) {
  return (
    {
      authenticated: '已登录',
      attention_required: '页面变化或验证码，需人工处理',
      disabled: '已停用',
      login_required: '尚未登录',
      qr_ready: '等待扫码',
      reauth: '登录已失效',
    } as const
  )[status];
}

function readCookie(name: string): string | null {
  const prefix = `${name}=`;
  for (const item of document.cookie.split(';')) {
    const normalized = item.trim();
    if (normalized.startsWith(prefix)) return decodeURIComponent(normalized.slice(prefix.length));
  }
  return null;
}

const controlClass =
  'mt-2 min-h-11 w-full rounded-lg border border-line bg-white px-3 py-2 text-ink-950 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-100';
const labelClass = 'text-sm text-ink-700';
const primaryButton =
  'min-h-11 rounded-lg bg-brand-700 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-60';
const secondaryButton =
  'min-h-11 rounded-lg border border-line bg-white px-4 py-2 text-sm font-semibold text-ink-800 hover:bg-surface-subtle';
