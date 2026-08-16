'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { listProjects } from '../know-02/source-upload-api';
import type { ProjectChoice } from '../know-02/source-upload.schema';
import {
  listBrowserPlatformAutomationPolicies,
  saveBrowserPlatformAutomationPolicy,
} from './platform-account-api';
import type { BrowserPlatformAutomationPolicy, PlatformAccount } from './platform-account.schema';

export function BrowserPlatformAutomationPanel({ account }: { readonly account: PlatformAccount }) {
  const [projects, setProjects] = useState<ProjectChoice[]>([]);
  const [policies, setPolicies] = useState<readonly BrowserPlatformAutomationPolicy[]>([]);
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const selected = useMemo(
    () => policies.find((policy) => policy.project_id === projectId),
    [policies, projectId],
  );
  const platformName = account.platform_code === 'lieju' ? '列举网' : '搜狐号';

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      listProjects(account.workspace_id, controller.signal),
      listBrowserPlatformAutomationPolicies(account.id, controller.signal),
    ])
      .then(([nextProjects, nextPolicies]) => {
        setProjects(nextProjects);
        setPolicies(nextPolicies);
        setProjectId(nextPolicies[0]?.project_id ?? nextProjects[0]?.id ?? '');
      })
      .catch(() => setMessage(`读取${platformName}自动化配置失败。`));
    return () => controller.abort();
  }, [account.id, account.workspace_id, platformName]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const csrf = readCookie('geo_csrf');
    if (!csrf || !projectId) return setMessage('缺少项目或安全令牌，请刷新后重试。');
    const form = new FormData(event.currentTarget);
    const target = Number(form.get('daily_target_count'));
    const limit = Number(form.get('daily_candidate_limit'));
    const schedules = String(form.get('daily_schedule_times') ?? '')
      .split(',')
      .map(normalizeTime)
      .filter((value): value is string => value !== null);
    if (
      !Number.isInteger(target) ||
      target < 1 ||
      target > 10 ||
      !Number.isInteger(limit) ||
      limit < target ||
      limit > 30 ||
      schedules.length !== target
    ) {
      return setMessage('每日目标为 1～10；候选上限不得低于目标；发布时间数量必须与目标一致。');
    }
    const enabled = form.get('enabled') === 'on';
    setBusy(true);
    setMessage(null);
    try {
      const saved = await saveBrowserPlatformAutomationPolicy(
        account.id,
        {
          dailyCandidateLimit: limit,
          dailyEnabled: enabled && form.get('daily_enabled') === 'on',
          dailyGenerationTime:
            normalizeTime(String(form.get('daily_generation_time'))) ?? '00:30:00',
          dailyScheduleTimes: schedules,
          dailyTargetCount: target,
          enabled,
          ...(selected ? { expectedVersion: selected.version } : {}),
          projectId,
        },
        csrf,
      );
      setPolicies((current) => [
        ...current.filter((policy) => policy.project_id !== saved.project_id),
        saved,
      ]);
      setMessage(`${platformName}全链路自动化配置已保存。`);
    } catch {
      setMessage(`保存${platformName}自动化配置失败。`);
    } finally {
      setBusy(false);
    }
  }

  const defaultTarget = account.platform_code === 'lieju' ? 1 : 3;
  const defaultSchedules = account.platform_code === 'lieju' ? '10:00' : '10:00,15:00,20:00';
  return (
    <div className="mt-6 border-t border-ink-100 pt-6">
      <h3 className="text-base font-semibold text-ink-950">全链路自动化</h3>
      <p className="mt-1 text-sm leading-6 text-ink-500">
        自动生文、质检、最多三次按报告重写、配图、排期并交给托管浏览器发布。
      </p>
      {account.platform_code === 'lieju' ? (
        <p className="mt-2 rounded-lg bg-brand-50 px-3 py-2 text-sm text-ink-700">
          列举网允许真实、具体的服务推广和自然咨询引导；联系方式、极限词、排名、虚假价格、资质、案例与承诺仍会被阻断。普通会员遇到验证码时转人工。
        </p>
      ) : null}
      <form className="mt-4 grid gap-3 md:grid-cols-2" onSubmit={save}>
        <label className="text-sm text-ink-700">
          项目
          <select
            className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2"
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
        <label className="text-sm text-ink-700">
          每日生成时间
          <input
            className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2"
            defaultValue={selected?.daily_generation_time.slice(0, 5) ?? '00:30'}
            key={`${projectId}-generation`}
            name="daily_generation_time"
            type="time"
          />
        </label>
        <label className="text-sm text-ink-700">
          每日目标
          <input
            className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2"
            defaultValue={selected?.daily_target_count ?? defaultTarget}
            key={`${projectId}-target`}
            max={10}
            min={1}
            name="daily_target_count"
            type="number"
          />
        </label>
        <label className="text-sm text-ink-700">
          候选上限
          <input
            className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2"
            defaultValue={selected?.daily_candidate_limit ?? defaultTarget * 3}
            key={`${projectId}-limit`}
            max={30}
            min={1}
            name="daily_candidate_limit"
            type="number"
          />
          <span className="mt-1 block text-xs leading-5 text-ink-500">
            当天最多尝试篇数；耗尽后，已合格内容照常排期，未完成名额转为需要处理。
          </span>
        </label>
        <label className="text-sm text-ink-700 md:col-span-2">
          发布时间（英文逗号分隔）
          <input
            className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2"
            defaultValue={
              selected?.daily_schedule_times.map((time) => time.slice(0, 5)).join(',') ??
              defaultSchedules
            }
            key={`${projectId}-schedules`}
            name="daily_schedule_times"
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input
            defaultChecked={selected?.enabled ?? false}
            key={`${projectId}-enabled`}
            name="enabled"
            type="checkbox"
          />
          启用自动化
        </label>
        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input
            defaultChecked={selected?.daily_enabled ?? false}
            key={`${projectId}-daily`}
            name="daily_enabled"
            type="checkbox"
          />
          启用每日批次
        </label>
        <div className="md:col-span-2 flex items-center gap-3">
          <button
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            disabled={busy || !projectId}
            type="submit"
          >
            {busy ? '保存中…' : '保存自动化配置'}
          </button>
          {selected?.today_batch ? (
            <span className="text-sm text-ink-500">
              今日：已尝试 {selected.today_batch.attempted_count}，已排期{' '}
              {selected.today_batch.scheduled_count}，已发布 {selected.today_batch.published_count}
            </span>
          ) : null}
        </div>
      </form>
      {message ? (
        <p aria-live="polite" className="mt-3 text-sm text-ink-700">
          {message}
        </p>
      ) : null}
    </div>
  );
}

function normalizeTime(value: string): string | null {
  const trimmed = value.trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/u.test(trimmed)) return null;
  return trimmed.length === 5 ? `${trimmed}:00` : trimmed;
}

function readCookie(name: string): string | null {
  const prefix = `${name}=`;
  const item = document.cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  return item ? decodeURIComponent(item.slice(prefix.length)) : null;
}
