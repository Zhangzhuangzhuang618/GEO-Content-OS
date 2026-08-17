'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { listProjects } from '../know-02/source-upload-api';
import type { ProjectChoice } from '../know-02/source-upload.schema';
import {
  listBrowserPlatformAutomationPolicies,
  PlatformAccountRequestError,
  saveBrowserPlatformAutomationPolicy,
  syncProjectKeywordPlatformScope,
} from './platform-account-api';
import type { BrowserPlatformAutomationPolicy, PlatformAccount } from './platform-account.schema';
import { automaticDailyScheduleTimes } from './automatic-daily-schedule';

export function BrowserPlatformAutomationPanel({ account }: { readonly account: PlatformAccount }) {
  const defaultTarget = account.platform_code === 'lieju' ? 1 : 3;
  const [projects, setProjects] = useState<ProjectChoice[]>([]);
  const [policies, setPolicies] = useState<readonly BrowserPlatformAutomationPolicy[]>([]);
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [syncingKeywords, setSyncingKeywords] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [dailyTargetCount, setDailyTargetCount] = useState(defaultTarget);
  const selected = useMemo(
    () => policies.find((policy) => policy.project_id === projectId),
    [policies, projectId],
  );
  const automaticScheduleTimes = useMemo(
    () => automaticDailyScheduleTimes(dailyTargetCount),
    [dailyTargetCount],
  );
  const platformName = account.platform_code === 'lieju' ? '列举网' : '搜狐号';

  useEffect(() => {
    setDailyTargetCount(selected?.daily_target_count ?? defaultTarget);
  }, [defaultTarget, selected?.daily_target_count, selected?.id]);

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
    const target = dailyTargetCount;
    const limit = Number(form.get('daily_candidate_limit'));
    if (
      !Number.isInteger(target) ||
      target < 1 ||
      target > 10 ||
      !Number.isInteger(limit) ||
      limit < target ||
      limit > 30
    ) {
      return setMessage('每日目标为 1～10；候选上限不得低于目标。');
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
          dailyScheduleTimes: automaticScheduleTimes,
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

  async function syncKeywords() {
    const csrf = readCookie('geo_csrf');
    if (!csrf || !projectId) return setMessage('缺少项目或安全令牌，请刷新后重试。');
    setSyncingKeywords(true);
    setMessage(null);
    try {
      const result = await syncProjectKeywordPlatformScope(projectId, account.platform_code, csrf);
      setMessage(
        result.matched_count === 0
          ? `当前项目没有可同步的关键词，请先在关键词管理中添加关键词。`
          : `已检查 ${result.matched_count} 个项目关键词，新增 ${result.changed_count} 个${platformName}适用范围；当前有 ${result.active_keyword_count} 个启用关键词可供新批次使用。已有失败批次不会自动重新生成。`,
      );
    } catch (error) {
      setMessage(
        error instanceof PlatformAccountRequestError && error.status === 403
          ? '同步关键词需要企业所有者、管理员或策略编辑权限。'
          : `同步项目关键词到${platformName}失败。`,
      );
    } finally {
      setSyncingKeywords(false);
    }
  }

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
        <div className="flex items-end">
          <button
            className="w-full rounded-lg border border-brand-300 bg-brand-50 px-3 py-2 text-sm font-medium text-brand-700 disabled:opacity-50"
            disabled={busy || syncingKeywords || !projectId}
            onClick={() => void syncKeywords()}
            type="button"
          >
            {syncingKeywords ? '同步中…' : `一键同步项目关键词到${platformName}`}
          </button>
        </div>
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
            max={10}
            min={1}
            onChange={(event) => {
              const nextTarget = event.currentTarget.valueAsNumber;
              if (Number.isInteger(nextTarget) && nextTarget >= 1 && nextTarget <= 10) {
                setDailyTargetCount(nextTarget);
              }
            }}
            type="number"
            value={dailyTargetCount}
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
        <div className="text-sm text-ink-700 md:col-span-2">
          系统自动排期
          <output className="mt-1 block min-h-10 w-full rounded-lg border border-ink-200 px-3 py-2">
            {automaticScheduleTimes.map((time) => time.slice(0, 5)).join('、')}
          </output>
          <span className="mt-1 block text-xs leading-5 text-ink-500">
            根据每日目标自动分布，无需手工填写；保存后每天按这些北京时间发布。
          </span>
        </div>
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
      {selected?.today_batch?.manual_items.length ? (
        <section className="mt-5 border-t border-line pt-4">
          <h4 className="font-semibold text-ink-950">需要处理的内容</h4>
          <p className="mt-1 text-xs leading-5 text-ink-500">
            内容问题请编辑后重新质检；发布问题请进入发布任务核验、重试或人工对账。
          </p>
          <div className="mt-3 space-y-3">
            {selected.today_batch.manual_items.map((item) => (
              <article
                className="rounded-xl border border-amber-200 bg-amber-50 p-4"
                key={item.automation_run_id}
              >
                <p className="font-semibold text-ink-950">
                  候选 {item.candidate_no} · {item.title ?? `未命名${platformName}内容`}
                </p>
                <p className="mt-1 text-xs text-ink-600">已自动重写 {item.rewrite_count}/3 次</p>
                <p className="mt-3 text-sm leading-6 text-amber-950">
                  {manualErrorSummary(item.last_error)}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link className={primaryLink} href={`/cont-04?id=${item.package_id}`}>
                    查看全文和处理
                  </Link>
                  {item.quality_report_id ? (
                    <Link className={secondaryLink} href={`/qual-01?id=${item.variant_id}`}>
                      查看质量报告
                    </Link>
                  ) : null}
                  {item.publish_job_id ? (
                    <Link className={secondaryLink} href={`/pub-03?id=${item.publish_job_id}`}>
                      查看发布任务
                    </Link>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
      {message ? (
        <p aria-live="polite" className="mt-3 text-sm text-ink-700">
          {message}
        </p>
      ) : null}
    </div>
  );
}

function manualErrorSummary(value: Readonly<Record<string, unknown>> | null): string {
  if (!value) return '未记录具体失败原因，请打开内容或发布任务查看当前状态。';
  const code = typeof value['code'] === 'string' ? value['code'] : '';
  const message = typeof value['message'] === 'string' ? value['message'] : '';
  return [code, message].filter(Boolean).join('：') || '未记录具体失败原因。';
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

const primaryLink =
  'rounded-lg bg-brand-600 px-3 py-2 text-xs font-semibold text-white hover:bg-brand-700';
const secondaryLink =
  'rounded-lg border border-line bg-white px-3 py-2 text-xs font-semibold text-ink-700 hover:bg-surface-subtle';
