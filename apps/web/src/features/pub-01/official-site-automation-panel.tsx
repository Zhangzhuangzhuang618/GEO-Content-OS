'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { listProjects } from '../know-02/source-upload-api';
import type { ProjectChoice } from '../know-02/source-upload.schema';
import {
  cancelOfficialSiteDailyBatch,
  listOfficialSiteAutomationPolicies,
  restartOfficialSiteDailyBatch,
  saveOfficialSiteAutomationPolicy,
} from './platform-account-api';
import type { OfficialSiteAutomationPolicy, PlatformAccount } from './platform-account.schema';

export function OfficialSiteAutomationPanel({
  account,
  onClose,
}: {
  readonly account: PlatformAccount;
  readonly onClose: () => void;
}) {
  const [projects, setProjects] = useState<ProjectChoice[]>([]);
  const [policies, setPolicies] = useState<readonly OfficialSiteAutomationPolicy[]>([]);
  const [projectId, setProjectId] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [dailyEnabled, setDailyEnabled] = useState(false);
  const [state, setState] = useState<'loading' | 'retrying' | 'ready' | 'saving' | 'error'>(
    'loading',
  );
  const [reloadVersion, setReloadVersion] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const selected = useMemo(
    () => policies.find((policy) => policy.project_id === projectId),
    [policies, projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    let refreshTimer: ReturnType<typeof setInterval> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let failureCount = 0;
    setState('loading');
    setMessage(null);

    const load = () => {
      void Promise.all([
        listProjects(account.workspace_id, controller.signal),
        listOfficialSiteAutomationPolicies(account.id, controller.signal),
      ])
        .then(([nextProjects, nextPolicies]) => {
          if (controller.signal.aborted) return;
          setProjects(nextProjects);
          setPolicies(nextPolicies);
          const firstProjectId = nextPolicies[0]?.project_id ?? nextProjects[0]?.id ?? '';
          setProjectId(firstProjectId);
          setEnabled(
            nextPolicies.find((item) => item.project_id === firstProjectId)?.enabled ?? false,
          );
          setDailyEnabled(
            nextPolicies.find((item) => item.project_id === firstProjectId)?.daily_enabled ?? false,
          );
          setState('ready');
          refreshTimer = setInterval(() => {
            void listOfficialSiteAutomationPolicies(account.id, controller.signal)
              .then((latestPolicies) => {
                if (!controller.signal.aborted) setPolicies(latestPolicies);
              })
              .catch(() => undefined);
          }, 15_000);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          const delay = INITIAL_LOAD_RETRY_DELAYS_MS[failureCount];
          if (delay === undefined) {
            setState('error');
            return;
          }
          failureCount += 1;
          setState('retrying');
          retryTimer = setTimeout(load, delay);
        });
    };

    load();
    return () => {
      controller.abort();
      if (refreshTimer) clearInterval(refreshTimer);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [account.id, account.workspace_id, reloadVersion]);

  function changeProject(nextProjectId: string) {
    setProjectId(nextProjectId);
    setEnabled(policies.find((policy) => policy.project_id === nextProjectId)?.enabled ?? false);
    setDailyEnabled(
      policies.find((policy) => policy.project_id === nextProjectId)?.daily_enabled ?? false,
    );
    setMessage(null);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const csrf = readCookie('geo_csrf');
    if (!csrf || !projectId) {
      setMessage('缺少项目或安全令牌，请刷新页面后重试。');
      return;
    }
    setState('saving');
    setMessage(null);
    try {
      const saved = await saveOfficialSiteAutomationPolicy(
        account.id,
        {
          dailyEnabled,
          enabled,
          ...(selected ? { expectedVersion: selected.version } : {}),
          projectId,
        },
        csrf,
      );
      setPolicies((current) => [
        ...current.filter((policy) => policy.project_id !== saved.project_id),
        {
          ...saved,
          today_batch: saved.today_batch ?? selected?.today_batch ?? null,
        },
      ]);
      setMessage(
        saved.daily_enabled
          ? '已开启每日计划：系统每天准备 10 篇合格内容，并按固定时段自动发布。'
          : saved.enabled
            ? '已开启单篇自动发布：官网内容通过机器门禁后会立即发布。'
            : '已关闭：新生成的官网内容不会自动进入发布闭环。',
      );
      setState('ready');
    } catch {
      setMessage('保存失败。账号、项目或策略版本可能已变化，请关闭后重新打开再试。');
      setState('ready');
    }
  }

  async function restartTodayBatch() {
    const batch = selected?.today_batch;
    if (!selected || !batch?.restart_allowed || restarting) return;
    const confirmed = window.confirm(
      `将保留今日第 ${batch.attempt_no} 次尝试的全部记录，并立即创建第 ${
        batch.attempt_no + 1
      } 次尝试。新批次最多再生成 30 篇候选，会产生新的 AI 调用成本。是否继续？`,
    );
    if (!confirmed) return;
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('缺少安全令牌，请刷新页面后重试。');
      return;
    }
    setRestarting(true);
    setMessage(null);
    try {
      const restarted = await restartOfficialSiteDailyBatch(
        account.id,
        {
          expectedBatchVersion: batch.version,
          projectId: selected.project_id,
        },
        csrf,
      );
      setPolicies((current) => [
        ...current.filter((policy) => policy.project_id !== restarted.project_id),
        restarted,
      ]);
      setMessage(
        `已重新发起今日第 ${restarted.today_batch?.attempt_no ?? batch.attempt_no + 1} 次尝试。系统正在按原质量标准补足 10 篇。`,
      );
    } catch {
      setMessage('重新发起失败。批次状态可能已变化，请关闭后重新打开再试。');
    } finally {
      setRestarting(false);
    }
  }

  async function cancelTodayBatch() {
    const batch = selected?.today_batch;
    if (!selected || batch?.status !== 'running' || cancelling) return;
    const confirmed = window.confirm(
      `确认终止今日第 ${batch.attempt_no} 次任务？\n\n系统会停止补题和自动排期；正在执行的 AI 请求可能仍会产生本次调用费用，但结果不会继续进入发布流程。已合格但尚未排期的文章会保留，不会自动发布。明天仍会按每日计划重新开始。`,
    );
    if (!confirmed) return;
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('缺少安全令牌，请刷新页面后重试。');
      return;
    }
    setCancelling(true);
    setMessage(null);
    try {
      const cancelled = await cancelOfficialSiteDailyBatch(
        account.id,
        {
          expectedBatchVersion: batch.version,
          projectId: selected.project_id,
        },
        csrf,
      );
      setPolicies((current) => [
        ...current.filter((policy) => policy.project_id !== cancelled.project_id),
        cancelled,
      ]);
      setMessage(
        `今日第 ${batch.attempt_no} 次任务已终止。系统不会继续补题或自动排期，明天仍会按每日计划重新开始。`,
      );
    } catch {
      setMessage('终止失败。批次状态可能已变化，请关闭后重新打开再试。');
    } finally {
      setCancelling(false);
    }
  }

  return (
    <form
      aria-label={`官网自动发布 ${account.display_name}`}
      className="mt-5 rounded-2xl border border-brand-200 bg-white p-5 shadow-panel sm:p-7"
      onSubmit={(event) => void save(event)}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-ink-950">官网自动发布</h2>
          <p className="mt-2 text-sm text-ink-500">
            仅影响所选项目的官网内容；其他平台仍按原有审核和发布流程处理。
          </p>
        </div>
        <button className={secondaryButton} onClick={onClose} type="button">
          关闭
        </button>
      </div>

      {state === 'loading' ? <p className="mt-5 text-sm text-ink-500">正在读取项目策略…</p> : null}
      {state === 'retrying' ? (
        <p className="mt-5 text-sm text-ink-500">服务刚刚不可用，正在自动重新连接…</p>
      ) : null}
      {state === 'error' ? (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <p className="text-sm text-red-700">暂时无法连接服务，请确认服务已启动后重试。</p>
          <button
            className={secondaryButton}
            onClick={() => setReloadVersion((current) => current + 1)}
            type="button"
          >
            重新加载
          </button>
        </div>
      ) : null}
      {state !== 'loading' && state !== 'retrying' && state !== 'error' ? (
        <>
          <div className="mt-5 grid gap-5 sm:grid-cols-2">
            <label className="text-sm text-ink-700">
              应用项目
              <select
                className={controlClass}
                onChange={(event) => changeProject(event.currentTarget.value)}
                required
                value={projectId}
              >
                {projects.length === 0 ? <option value="">当前工作区没有可用项目</option> : null}
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-3 self-end rounded-xl border border-line px-4 py-3 text-sm text-ink-900">
              <input
                checked={enabled}
                disabled={account.status !== 'active' || account.publish_mode !== 'api'}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setEnabled(checked);
                  if (!checked) setDailyEnabled(false);
                }}
                type="checkbox"
              />
              单篇内容质检通过后立即发布
            </label>
          </div>
          <label className="mt-5 flex items-start gap-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-4 text-sm text-ink-900">
            <input
              checked={dailyEnabled}
              className="mt-1"
              disabled={account.status !== 'active' || account.publish_mode !== 'api'}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setDailyEnabled(checked);
                if (checked) setEnabled(true);
              }}
              type="checkbox"
            />
            <span>
              <span className="block font-semibold text-ink-950">每天自动生产并排期发布 10 篇</span>
              <span className="mt-1 block leading-6 text-ink-600">
                每天 00:00 开始准备；不合格内容最多重写 3 次，仍不合格会自动换题补位，最多尝试 30
                篇，不降低质量标准。
              </span>
            </span>
          </label>
          {selected?.today_batch ? (
            <TodayBatchStatus
              cancelling={cancelling}
              onCancel={() => void cancelTodayBatch()}
              onRestart={() => void restartTodayBatch()}
              policy={selected}
              restarting={restarting}
            />
          ) : null}
          <div className="mt-5 rounded-xl bg-surface-subtle p-4 text-sm leading-6 text-ink-700">
            <p className="font-semibold text-ink-950">固定安全门禁</p>
            <p className="mt-1">
              GEO 总分 ≥85；事实准确性和品牌一致性 ≥90；可读性与安全性 ≥85；问题覆盖度和平台适配度
              ≥80。
            </p>
            <p>
              任一阻断问题都会禁止发布。单篇内容连续 3 次重写仍不通过时转为“待人工处理”；
              每日计划中的不合格候选会退出并自动补位。官网调用失败最多重试 3 次。
            </p>
            <p className="mt-2">
              每日计划发布时间：08:00、09:30、11:00、12:30、14:00、15:30、17:00、18:30、20:00、21:30
              （北京时间）。
            </p>
          </div>
          <div aria-live="polite" className="mt-4 min-h-6 text-sm text-ink-700">
            {message}
          </div>
          <div className="mt-3 flex justify-end">
            <button
              className={primaryButton}
              disabled={state === 'saving' || !projectId}
              type="submit"
            >
              {state === 'saving' ? '正在保存…' : '保存自动发布设置'}
            </button>
          </div>
        </>
      ) : null}
    </form>
  );
}

function TodayBatchStatus({
  cancelling,
  onCancel,
  onRestart,
  policy,
  restarting,
}: {
  readonly cancelling: boolean;
  readonly onCancel: () => void;
  readonly onRestart: () => void;
  readonly policy: OfficialSiteAutomationPolicy;
  readonly restarting: boolean;
}) {
  const batch = policy.today_batch;
  if (!batch) return null;
  const statusText = {
    attention_required: '需要人工处理',
    cancelled: '已取消',
    completed: '今日 10 篇已全部发布',
    running: '正在准备今日内容',
    scheduled: '今日内容已排期',
  }[batch.status];
  return (
    <section aria-label="今日发布进度" className="mt-5 rounded-xl border border-line bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-semibold text-ink-950">今日发布进度（第 {batch.attempt_no} 次尝试）</p>
          <p className="mt-1 text-sm text-ink-600">{statusText}</p>
        </div>
        <p className="text-sm font-semibold text-brand-700">
          已发布 {batch.published_count}/{batch.target_count}
        </p>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
        <ProgressValue label="已尝试" value={batch.attempted_count} />
        <ProgressValue label="处理中" value={batch.in_progress_count} />
        <ProgressValue label="已合格" value={batch.qualified_count} />
        <ProgressValue label="已排期" value={batch.scheduled_count} />
        <ProgressValue label="已淘汰" value={batch.retired_count} />
      </div>
      {batch.last_error_message ? (
        <p
          className={`mt-4 rounded-lg px-3 py-2 text-sm ${
            batch.status === 'cancelled'
              ? 'bg-surface-subtle text-ink-700'
              : 'bg-red-50 text-red-700'
          }`}
        >
          {batch.last_error_message}
        </p>
      ) : null}
      {batch.status === 'running' ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-3">
          <p className="text-sm leading-6 text-red-900">
            如果已确认本批次异常，可以立即停止继续生成和排期。已完成的记录不会删除。
          </p>
          <button className={dangerButton} disabled={cancelling} onClick={onCancel} type="button">
            {cancelling ? '正在终止…' : '终止今日任务'}
          </button>
        </div>
      ) : null}
      {batch.restart_allowed ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3">
          <p className="text-sm leading-6 text-amber-900">
            本次已用完 30 个候选仍未补足 10 篇。可以保留失败记录并重新开始一批。
          </p>
          <button
            className={secondaryButton}
            disabled={restarting}
            onClick={onRestart}
            type="button"
          >
            {restarting ? '正在重新发起…' : '重新发起今日批次'}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function ProgressValue({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div className="rounded-lg bg-surface-subtle px-3 py-2">
      <span className="block text-ink-500">{label}</span>
      <span className="mt-1 block text-lg font-semibold text-ink-950">{value}</span>
    </div>
  );
}

function readCookie(name: string): string | null {
  const prefix = `${name}=`;
  const item = document.cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  return item ? decodeURIComponent(item.slice(prefix.length)) : null;
}

const controlClass =
  'mt-2 min-h-11 w-full rounded-xl border border-line bg-white px-3 text-ink-950 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';
const primaryButton =
  'min-h-11 rounded-xl bg-brand-600 px-5 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50';
const secondaryButton =
  'min-h-11 rounded-xl border border-line bg-white px-4 font-semibold text-ink-800 hover:border-brand-300';
const dangerButton =
  'min-h-11 rounded-xl border border-red-300 bg-white px-4 font-semibold text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50';
const INITIAL_LOAD_RETRY_DELAYS_MS = [500, 1_500, 3_000] as const;
