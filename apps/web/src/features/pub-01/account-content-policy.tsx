'use client';

import { useEffect, useState } from 'react';
import { z } from 'zod';
import { apiGet } from '@/lib/api-fetch';
import { createRequestUuid } from '@/lib/request-uuid';
import { listProjects } from '../know-02/source-upload-api';
import type { ProjectChoice } from '../know-02/source-upload.schema';
import { listSources } from '../know-01/source-api';
import type { SourceListItem } from '../know-01/source.schema';
import type { PlatformAccount } from './platform-account.schema';

export const ContentStyleSchema = z.enum(['standard', 'company_recommendation']);
export type ContentStyle = z.infer<typeof ContentStyleSchema>;
const CompanySchema = z
  .object({ id: z.uuid(), legal_name: z.string(), source_document_ids: z.array(z.uuid()) })
  .strict();
const PolicySchema = z
  .object({
    account_id: z.uuid(),
    workspace_id: z.uuid(),
    platform_code: z.enum(['official_site', 'lieju', 'douyin']),
    default_style: ContentStyleSchema,
    recommended_companies: z.array(CompanySchema),
    version: z.number().int(),
  })
  .strict();
type Policy = z.infer<typeof PolicySchema>;
const origin = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export function ContentStyleSelect({
  value,
  onChange,
  inheritLabel = '跟随账号默认',
  label = '生文风格',
}: {
  value: ContentStyle | '';
  onChange: (value: ContentStyle | '') => void;
  inheritLabel?: string;
  label?: string;
}) {
  return (
    <label className="grid gap-2 text-sm">
      {label}
      <select
        aria-label={label}
        className="rounded-lg border border-line bg-white p-2"
        value={value}
        onChange={(event) => onChange(event.target.value as ContentStyle | '')}
      >
        {inheritLabel ? <option value="">{inheritLabel}</option> : null}
        <option value="standard">现有常规风格</option>
        <option value="company_recommendation">硬广·多公司推荐</option>
      </select>
    </label>
  );
}

export function AccountContentPolicyPanel({
  account,
  onClose,
}: {
  account: PlatformAccount;
  onClose: () => void;
}) {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [projects, setProjects] = useState<ProjectChoice[]>([]);
  const [projectId, setProjectId] = useState('');
  const [sources, setSources] = useState<SourceListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setPolicy(null);
    setMessage('');
    void Promise.all([
      apiGet(`${origin}/api/v1/platform-accounts/${account.id}/content-policy`, {
        signal: controller.signal,
        cacheTtlMs: 0,
      }).then(async (response) => {
        if (!response.ok) throw new Error('读取内容设置失败');
        return PolicySchema.parse((await response.json()).data);
      }),
      listProjects(account.workspace_id, controller.signal),
    ])
      .then(([next, items]) => {
        if (!controller.signal.aborted) {
          setPolicy(next);
          setProjects(items);
          setProjectId(items[0]?.id ?? '');
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setMessage(error instanceof Error ? error.message : '读取失败');
      });
    return () => controller.abort();
  }, [account.id, account.workspace_id]);
  useEffect(() => {
    const controller = new AbortController();
    setSources([]);
    setCursor(null);
    if (projectId)
      void listSources(
        { projectId, workspaceId: account.workspace_id, status: 'active' },
        controller.signal,
      )
        .then((page) => {
          if (!controller.signal.aborted) {
            setSources(page.items);
            setCursor(page.nextCursor);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) setMessage('资料列表读取失败，请重选项目');
        });
    return () => controller.abort();
  }, [projectId, account.workspace_id]);
  async function loadMore() {
    if (!cursor) return;
    setBusy(true);
    try {
      const page = await listSources({
        projectId,
        workspaceId: account.workspace_id,
        status: 'active',
        cursor,
      });
      setSources((items) => [...items, ...page.items]);
      setCursor(page.nextCursor);
    } catch {
      setMessage('读取更多资料失败');
    } finally {
      setBusy(false);
    }
  }
  function updateCompany(index: number, patch: Partial<Policy['recommended_companies'][number]>) {
    setPolicy((current) =>
      current
        ? {
            ...current,
            recommended_companies: current.recommended_companies.map((item, i) =>
              i === index ? { ...item, ...patch } : item,
            ),
          }
        : null,
    );
  }
  function move(index: number, offset: number) {
    if (!policy) return;
    const items = [...policy.recommended_companies];
    const item = items.splice(index, 1)[0]!;
    items.splice(index + offset, 0, item);
    setPolicy({ ...policy, recommended_companies: items });
  }
  async function save() {
    if (!policy) return;
    const csrf = document.cookie
      .split('; ')
      .find((part) => part.startsWith('geo_csrf='))
      ?.slice('geo_csrf='.length);
    if (!csrf) return setMessage('安全令牌缺失，请刷新后重试');
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(
        `${origin}/api/v1/platform-accounts/${account.id}/content-policy`,
        {
          method: 'PUT',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': decodeURIComponent(csrf),
            'idempotency-key': `content-policy-${createRequestUuid()}`,
          },
          body: JSON.stringify({
            default_style: policy.default_style,
            recommended_companies: policy.recommended_companies,
            expected_version: policy.version,
          }),
        },
      );
      const body = await response.json();
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? '设置已被更新，请关闭后重新打开再保存'
            : (body.error?.message ?? '保存失败，请检查企业全称和资料权限'),
        );
      setPolicy(PolicySchema.parse(body.data));
      setMessage('已保存。只影响后续新建任务，已创建稿件与批次不变。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="mt-5 grid gap-4 rounded-2xl border border-line bg-white p-5"
      aria-label="账号内容设置"
    >
      <div className="flex justify-between">
        <h3 className="font-semibold">{account.display_name} · 内容设置</h3>
        <button type="button" onClick={onClose}>
          关闭
        </button>
      </div>
      <p className="text-sm text-ink-600">
        硬广按名单顺序介绍企业。每家公司绑定自己的资料；不生成独立排名或虚构用户亲历。抖音启用硬广时采用企业介绍口吻，不修改已保存的常规口吻。
      </p>
      {policy ? (
        <>
          <ContentStyleSelect
            value={policy.default_style}
            inheritLabel=""
            label="账号默认生文风格"
            onChange={(value) => {
              if (value) setPolicy({ ...policy, default_style: value });
            }}
          />
          <label className="grid gap-2 text-sm">
            浏览资料所属项目
            <select
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              className="rounded-lg border border-line p-2"
            >
              <option value="">选择项目</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-ink-600">
            生成时只能使用任务所在项目或工作区通用资料。需要 2–6
            家公司，每家至少一份已解析且有效的资料；可先保存未完成的配置。
          </p>
          {policy.recommended_companies.length === 0 ? (
            <button
              type="button"
              onClick={() =>
                setPolicy({
                  ...policy,
                  recommended_companies: [
                    '广东众人搬家起重吊装有限公司',
                    '广州志远搬家服务有限公司',
                  ].map((legal_name) => ({
                    id: createRequestUuid(),
                    legal_name,
                    source_document_ids: [],
                  })),
                })
              }
            >
              填入本次推荐名单（众人、志远）
            </button>
          ) : null}
          {policy.recommended_companies.map((company, index) => (
            <fieldset key={company.id} className="grid gap-2 rounded-lg border border-line p-3">
              <legend>推荐企业 {index + 1}</legend>
              <input
                aria-label={`推荐企业 ${index + 1} 全称`}
                value={company.legal_name}
                placeholder="完整法定企业名称"
                onChange={(event) => updateCompany(index, { legal_name: event.target.value })}
                className="rounded-lg border border-line p-2"
              />
              <div className="flex gap-3 text-sm">
                <button disabled={index === 0 || busy} onClick={() => move(index, -1)}>
                  上移
                </button>
                <button
                  disabled={index === policy.recommended_companies.length - 1 || busy}
                  onClick={() => move(index, 1)}
                >
                  下移
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    setPolicy({
                      ...policy,
                      recommended_companies: policy.recommended_companies.filter(
                        (_, i) => i !== index,
                      ),
                    })
                  }
                >
                  移除企业
                </button>
              </div>
              {sources.map((source) => (
                <label key={source.id} className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={company.source_document_ids.includes(source.id)}
                    onChange={(event) =>
                      updateCompany(index, {
                        source_document_ids: event.target.checked
                          ? [...company.source_document_ids, source.id]
                          : company.source_document_ids.filter((id) => id !== source.id),
                      })
                    }
                  />
                  {source.title}
                </label>
              ))}
              {company.source_document_ids
                .filter((id) => !sources.some((source) => source.id === id))
                .map((id) => (
                  <p key={id} className="text-xs">
                    已绑定资料（不在当前列表）：{id}{' '}
                    <button
                      onClick={() =>
                        updateCompany(index, {
                          source_document_ids: company.source_document_ids.filter(
                            (item) => item !== id,
                          ),
                        })
                      }
                    >
                      解除绑定
                    </button>
                  </p>
                ))}
              <p className="text-xs">已绑定 {company.source_document_ids.length} 份资料</p>
            </fieldset>
          ))}
          {cursor ? (
            <button disabled={busy} onClick={() => void loadMore()}>
              加载更多资料
            </button>
          ) : null}
          <button
            disabled={busy || policy.recommended_companies.length >= 6}
            onClick={() =>
              setPolicy({
                ...policy,
                recommended_companies: [
                  ...policy.recommended_companies,
                  { id: createRequestUuid(), legal_name: '', source_document_ids: [] },
                ],
              })
            }
          >
            添加推荐企业
          </button>
          <button
            disabled={busy}
            onClick={() => void save()}
            className="rounded-lg bg-blue-700 p-2 text-white"
          >
            {busy ? '处理中…' : '保存内容设置'}
          </button>
        </>
      ) : (
        <p>正在读取设置…</p>
      )}
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
    </section>
  );
}
