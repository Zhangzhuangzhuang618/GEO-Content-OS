'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { listProjects } from '../know-02/source-upload-api';
import type { ProjectChoice } from '../know-02/source-upload.schema';
import {
  listOfficialSiteAutomationPolicies,
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
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const selected = useMemo(
    () => policies.find((policy) => policy.project_id === projectId),
    [policies, projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
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
        setState('ready');
      })
      .catch(() => {
        if (!controller.signal.aborted) setState('error');
      });
    return () => controller.abort();
  }, [account.id, account.workspace_id]);

  function changeProject(nextProjectId: string) {
    setProjectId(nextProjectId);
    setEnabled(policies.find((policy) => policy.project_id === nextProjectId)?.enabled ?? false);
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
      setMessage(
        saved.enabled
          ? '已开启：官网内容通过机器门禁后会直接发布；不通过时最多自动重写 3 次。'
          : '已关闭：新生成的官网内容不会自动进入发布闭环。',
      );
      setState('ready');
    } catch {
      setMessage('保存失败。账号、项目或策略版本可能已变化，请关闭后重新打开再试。');
      setState('ready');
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
      {state === 'error' ? (
        <p className="mt-5 text-sm text-red-700">无法加载自动发布策略。</p>
      ) : null}
      {state !== 'loading' && state !== 'error' ? (
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
                onChange={(event) => setEnabled(event.currentTarget.checked)}
                type="checkbox"
              />
              通过机器质检后立即发布到官网
            </label>
          </div>
          <div className="mt-5 rounded-xl bg-surface-subtle p-4 text-sm leading-6 text-ink-700">
            <p className="font-semibold text-ink-950">固定安全门禁</p>
            <p className="mt-1">
              GEO 总分 ≥85；事实准确性和品牌一致性 ≥90；可读性与安全性 ≥85；问题覆盖度和平台适配度
              ≥80。
            </p>
            <p>
              任一阻断问题都会禁止发布。未通过时最多重写 3
              次；仍未通过则转为“待人工处理”。官网调用失败最多重试 3 次。
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
