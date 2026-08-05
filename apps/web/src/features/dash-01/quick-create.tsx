'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';

import { getAccountSession } from '../app-shell/account-api';
import type { TenantRole } from '../auth-02/tenant.schema';
import type { BriefObjective, PlatformCode } from '../cont-01/brief-list.schema';
import {
  BriefEditorRequestError,
  createContentPackage,
  saveBrief,
} from '../cont-02/brief-editor-api';
import type { BriefSaveInput } from '../cont-02/brief-editor.schema';
import { generatePackage, getContentPackageDetail } from '../cont-04/content-package-detail-api';
import { listSources } from '../know-01/source-api';
import type { SourceListItem } from '../know-01/source.schema';
import type { Workspace } from '../set-02/workspace-settings.schema';
import { listBrandProfiles } from '../str-01/brand-profile-list-api';
import { createBrandProfile, publishBrandProfile } from '../str-02/brand-profile-api';
import {
  createKeywordSet,
  listKeywords,
  listKeywordSets,
  upsertKeywords,
} from '../str-04/keyword-set-api';
import type { Keyword } from '../str-04/keyword-set.schema';
import { createProject, listProjects } from './dashboard-api';
import type { DashboardProject } from './dashboard.schema';

const CREATOR_ROLES = new Set<TenantRole>(['tenant_owner', 'tenant_admin', 'content_editor']);
const PLATFORMS = [
  ['official_site', '官网'],
  ['baijiahao', '百家号'],
  ['toutiao', '头条号'],
  ['zhihu', '知乎'],
  ['xiaohongshu', '小红书'],
  ['wechat_mp', '微信公众号'],
  ['douyin', '抖音'],
] as const satisfies readonly (readonly [PlatformCode, string])[];
const ALL_PLATFORMS = PLATFORMS.map(([code]) => code);

interface QuickCreateProps {
  readonly initialProjectId: string;
  readonly initialProjects: readonly DashboardProject[];
  readonly initialTopic: string;
  readonly initialWorkspaceId: string;
  readonly role: TenantRole;
  readonly workspaces: readonly Workspace[];
}

type Recovery =
  | { readonly brief: Awaited<ReturnType<typeof saveBrief>>; readonly step: 'package' }
  | { readonly packageId: string; readonly step: 'generation' }
  | null;

export function QuickCreate({
  initialProjectId,
  initialProjects,
  initialTopic,
  initialWorkspaceId,
  role,
  workspaces,
}: QuickCreateProps) {
  const initialWorkspace = workspaces.find((item) => item.id === initialWorkspaceId);
  const defaults = initialWorkspace?.settings.default_platform_codes ?? ['official_site'];
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId);
  const [title, setTitle] = useState(initialTopic);
  const [projects, setProjects] = useState<readonly DashboardProject[]>(initialProjects);
  const [projectId, setProjectId] = useState(initialProjectId || initialProjects[0]?.id || '');
  const [projectName, setProjectName] = useState('');
  const [projectSetupBusy, setProjectSetupBusy] = useState(false);
  const [platforms, setPlatforms] = useState<readonly PlatformCode[]>(defaults);
  const [objective, setObjective] = useState<BriefObjective>('awareness');
  const [keywords, setKeywords] = useState<readonly Keyword[]>([]);
  const [keywordId, setKeywordId] = useState('');
  const [keywordSetId, setKeywordSetId] = useState<string | null>(null);
  const [hasPublishedBrand, setHasPublishedBrand] = useState(false);
  const [sources, setSources] = useState<readonly SourceListItem[]>([]);
  const [selectedSourceIds, setSelectedSourceIds] = useState<readonly string[]>([]);
  const [configState, setConfigState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<Recovery>(null);
  const submitInFlight = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    if (!projectId) {
      setKeywords([]);
      setSources([]);
      setSelectedSourceIds([]);
      setConfigState('ready');
      return () => controller.abort();
    }
    setConfigState('loading');
    void loadGenerationContext(projectId, workspaceId, controller.signal)
      .then((context) => {
        setKeywords(context.keywords);
        setKeywordSetId(context.keywordSetId);
        setHasPublishedBrand(context.hasPublishedBrand);
        setSources(context.sources);
        setSelectedSourceIds(context.sources.map((source) => source.id));
        setKeywordId('');
        setConfigState('ready');
      })
      .catch(() => {
        if (!controller.signal.aborted) setConfigState('error');
      });
    return () => controller.abort();
  }, [projectId, workspaceId]);

  useEffect(() => {
    if (initialTopic) setTitle(initialTopic);
  }, [initialTopic]);

  const canCreate = CREATOR_ROLES.has(role);
  const canPrepareKeywords = role === 'tenant_owner' || role === 'tenant_admin';
  const selectedAll = platforms.length === ALL_PLATFORMS.length;
  const compatibleKeywords = useMemo(
    () => keywords.filter((item) => keywordSupportsPlatforms(item, platforms)),
    [keywords, platforms],
  );
  const selectedKeyword = useMemo(
    () => compatibleKeywords.find((item) => item.id === keywordId) ?? compatibleKeywords[0],
    [compatibleKeywords, keywordId],
  );

  async function changeWorkspace(nextWorkspaceId: string) {
    setWorkspaceId(nextWorkspaceId);
    setProjectId('');
    setProjects([]);
    setKeywords([]);
    setSources([]);
    setSelectedSourceIds([]);
    setHasPublishedBrand(false);
    setConfigState('loading');
    const workspace = workspaces.find((item) => item.id === nextWorkspaceId);
    setPlatforms(workspace?.settings.default_platform_codes ?? ['official_site']);
    try {
      const nextProjects = await listProjects(nextWorkspaceId);
      setProjects(nextProjects);
      setProjectId(nextProjects[0]?.id ?? '');
      if (nextProjects.length === 0) setConfigState('ready');
    } catch {
      setConfigState('error');
    }
  }

  function togglePlatform(code: PlatformCode) {
    setPlatforms((current) =>
      current.includes(code) ? current.filter((item) => item !== code) : [...current, code],
    );
  }

  async function createFirstProject() {
    const name = projectName.trim();
    if (!name) return setStatus('请填写项目名称，例如“官网内容运营”。');
    const csrf = readCookie('geo_csrf');
    if (!csrf) return setStatus('登录安全令牌尚未就绪，请刷新页面后重试。');
    setProjectSetupBusy(true);
    setStatus('正在创建项目…');
    try {
      const session = await getAccountSession();
      const created = await createProject({ name, ownerId: session.user.id, workspaceId }, csrf);
      setProjects([created]);
      setProjectId(created.id);
      setProjectName('');
      setStatus('项目已创建，可以继续填写主题并生成内容。');
    } catch {
      setStatus('项目创建失败，请检查权限或网络后重试。');
    } finally {
      setProjectSetupBusy(false);
    }
  }

  async function submit(form: HTMLFormElement) {
    if (submitInFlight.current) return;
    const data = new FormData(form);
    const title = String(data.get('title') ?? '').trim();
    if (title.length < 2) return setStatus('请用至少两个字说明想创作什么。');
    if (platforms.length === 0) return setStatus('请至少选择一个发布平台。');
    if (!projectId) return setStatus('当前工作区还没有项目，请先创建项目。');
    const csrf = readCookie('geo_csrf');
    if (!csrf) return setStatus('登录安全令牌尚未就绪，请刷新页面后重试。');

    submitInFlight.current = true;
    setBusy(true);
    try {
      let resolvedKeyword = selectedKeyword;
      if (!resolvedKeyword && canPrepareKeywords) {
        setStatus('正在根据主题准备核心关键词…');
        try {
          const setId =
            keywordSetId ??
            (await createKeywordSet({ name: '快速创作关键词', projectId }, csrf)).id;
          const created = await upsertKeywords(
            setId,
            [
              {
                intents: ['informational'],
                platform_scope: [...platforms],
                priority: 50,
                status: 'active',
                synonyms: [],
                term: title,
              },
            ],
            csrf,
          );
          resolvedKeyword = created.find((item) => item.term === title) ?? created[0];
          if (!resolvedKeyword || !keywordSupportsPlatforms(resolvedKeyword, platforms)) {
            throw new Error('Keyword creation returned no platform-compatible result');
          }
          setKeywordSetId(setId);
          setKeywords((current) => [
            ...current.filter((item) => !created.some((next) => next.id === item.id)),
            ...created,
          ]);
        } catch {
          return setStatus(
            '无法准备适用于所选平台的关键词，请到“品牌与选题 → 关键词管理”完成配置后重试。',
          );
        }
      }
      if (!resolvedKeyword || !keywordSupportsPlatforms(resolvedKeyword, platforms)) {
        return setStatus('当前项目没有适用于所选平台的关键词，请联系管理员添加关键词。');
      }

      const audience = String(data.get('audience') ?? '').trim();
      const input: BriefSaveInput = {
        audience: audience || '对该主题感兴趣的潜在读者与客户',
        constraints: {
          additional_instructions: optionalText(data.get('instructions')),
          cta: optionalText(data.get('cta')),
          schema_version: 'brief-constraints@1',
        },
        due_at: null,
        keyword_ids: [resolvedKeyword.id],
        objective,
        platform_codes: [...platforms],
        primary_keyword_id: resolvedKeyword.id,
        project_id: projectId,
        source_ids: [...selectedSourceIds],
        title,
        workspace_id: workspaceId,
      };

      setRecovery(null);
      setStatus('正在保存创作要求…');
      const brief = await saveBrief(input, csrf);
      setRecovery({ brief, step: 'package' });
      await createAndGenerate(brief, csrf);
    } catch (error) {
      setStatus(briefSaveErrorMessage(error));
    } finally {
      submitInFlight.current = false;
      setBusy(false);
    }
  }

  async function createAndGenerate(brief: Awaited<ReturnType<typeof saveBrief>>, csrf: string) {
    try {
      setStatus('正在创建多平台内容任务…');
      const packageId = await createContentPackage(brief, csrf);
      setRecovery({ packageId, step: 'generation' });
      await startGeneration(packageId, csrf);
    } catch {
      setStatus('创作要求已保存，但内容任务创建失败。你可以继续重试，不需要重新填写。');
    }
  }

  async function startGeneration(packageId: string, csrf: string) {
    try {
      await ensureBrandProfile(csrf);
    } catch {
      setStatus(
        '内容任务已创建，但无法准备品牌策略。请到“品牌与选题 → 品牌策略”发布一份策略后重试。',
      );
      return;
    }
    try {
      setStatus('正在启动多平台生成…');
      const detail = await getContentPackageDetail(packageId);
      await generatePackage(detail, 'balanced', csrf);
      setRecovery(null);
      setStatus('生成任务已启动，正在打开进度页面…');
      window.location.assign(`/cont-04?id=${packageId}&created=1`);
    } catch {
      setStatus('内容任务已创建，但生成暂未启动。你可以重试，或进入详情继续操作。');
    }
  }

  async function ensureBrandProfile(csrf: string) {
    if (hasPublishedBrand) return;
    if (!canPrepareKeywords) throw new Error('Brand profile permission is required');
    setStatus('正在准备基础品牌策略…');
    const published = await listBrandProfiles('published');
    if (published.some((item) => item.workspace_id === workspaceId)) {
      setHasPublishedBrand(true);
      return;
    }
    const workspaceName = workspaces.find((item) => item.id === workspaceId)?.name ?? '当前工作区';
    const projectName = projects.find((item) => item.id === projectId)?.name ?? '当前项目';
    const draft = await createBrandProfile(
      {
        audience: '对该主题感兴趣的潜在读者与客户',
        banned: '不得虚构事实、数据、案例或客户评价',
        compliance: '事实性陈述必须可验证；不确定信息需要明确标注',
        cta: '',
        differentiators: '',
        positioning: `${workspaceName}围绕${projectName}提供专业、清晰、可信的信息与服务。`,
        tone: '专业、清晰、克制，避免夸张和无法验证的承诺',
        workspace_id: workspaceId,
      },
      csrf,
    );
    await publishBrandProfile(draft, csrf);
    setHasPublishedBrand(true);
  }

  async function resume() {
    if (!recovery) return;
    const csrf = readCookie('geo_csrf');
    if (!csrf) return setStatus('登录安全令牌尚未就绪，请刷新页面后重试。');
    setBusy(true);
    if (recovery.step === 'package') await createAndGenerate(recovery.brief, csrf);
    else await startGeneration(recovery.packageId, csrf);
    setBusy(false);
  }

  if (!canCreate) {
    return (
      <section
        className="rounded-3xl border border-line bg-white p-6 shadow-panel"
        id="create-content"
      >
        <h2 className="text-xl font-semibold text-ink-950">创建内容</h2>
        <p className="mt-2 text-sm text-ink-500">当前角色可查看内容，但没有创建和生成权限。</p>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="quick-create-title"
      className="scroll-mt-24 overflow-hidden rounded-3xl border border-brand-100 bg-white shadow-panel"
      id="create-content"
    >
      <div className="border-b border-brand-100 bg-brand-50 px-6 py-5 sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-semibold text-brand-700">新建内容</p>
          <ol
            aria-label="创建内容步骤"
            className="flex flex-wrap items-center gap-2 text-xs font-medium text-ink-500"
          >
            {['填写主题', '选择平台', '补充资料', '开始生成'].map((step, index) => (
              <li className="flex items-center gap-2" key={step}>
                <span className="flex size-6 items-center justify-center rounded-full bg-white text-brand-700">
                  {index + 1}
                </span>
                <span className="hidden sm:inline">{step}</span>
              </li>
            ))}
          </ol>
        </div>
        <h2
          className="mt-1 text-2xl font-semibold tracking-tight text-ink-950"
          id="quick-create-title"
        >
          今天想创作什么？
        </h2>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          只需填写主题并选择平台，其余内容可以交给系统，也可以按需补充。
        </p>
      </div>
      <form
        className="p-6 sm:p-8"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(event.currentTarget);
        }}
      >
        <label className="block text-sm font-semibold text-ink-700">
          <span className="flex items-center gap-2">
            <StepNumber value={1} />
            想创作什么内容？
            <span className="font-normal text-ink-500">必填</span>
          </span>
          <textarea
            className="mt-2 min-h-28 w-full rounded-xl border border-line bg-white px-4 py-3 text-base text-ink-950 outline-none placeholder:text-ink-500 focus:border-brand-600 focus:ring-2 focus:ring-brand-100"
            maxLength={80}
            name="title"
            onChange={(event) => setTitle(event.target.value)}
            placeholder="例如：介绍企业如何通过 GEO 提升品牌在 AI 搜索中的可见度"
            required
            value={title}
          />
        </label>

        <fieldset className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <legend className="text-sm font-semibold text-ink-700">
              <span className="flex items-center gap-2">
                <StepNumber value={2} />
                希望生成哪些平台的内容？
              </span>
            </legend>
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-brand-700">
              <input
                checked={selectedAll}
                onChange={(event) => setPlatforms(event.target.checked ? ALL_PLATFORMS : [])}
                type="checkbox"
              />
              全部平台
            </label>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-4">
            {PLATFORMS.map(([code, label]) => (
              <label
                className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-control border px-3 text-sm ${
                  platforms.includes(code)
                    ? 'border-brand-500 bg-brand-50 font-medium text-brand-700'
                    : 'border-line bg-white text-ink-700'
                }`}
                key={code}
              >
                <input
                  checked={platforms.includes(code)}
                  onChange={() => togglePlatform(code)}
                  type="checkbox"
                  value={code}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>

        {projects.length === 0 ? (
          <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-5">
            {canPrepareKeywords ? (
              <>
                <h3 className="font-semibold text-ink-950">先创建第一个项目</h3>
                <p className="mt-1 text-sm leading-6 text-ink-600">
                  项目用于归类主题、资料和生成记录。创建后会自动选中，不会离开当前页面。
                </p>
                <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                  <label className="flex-1 text-sm font-medium text-ink-700">
                    项目名称
                    <input
                      className="mt-2 h-11 w-full rounded-control border border-line bg-white px-3 text-sm text-ink-950"
                      maxLength={160}
                      onChange={(event) => setProjectName(event.target.value)}
                      placeholder="例如：官网内容运营"
                      value={projectName}
                    />
                  </label>
                  <button
                    className="self-end rounded-control bg-ink-950 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50"
                    disabled={projectSetupBusy}
                    onClick={() => void createFirstProject()}
                    type="button"
                  >
                    {projectSetupBusy ? '正在创建…' : '创建项目'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 className="font-semibold text-ink-950">当前工作区还没有项目</h3>
                <p className="mt-1 text-sm leading-6 text-ink-600">
                  请联系企业管理员创建项目后再开始生成内容。
                </p>
              </>
            )}
          </div>
        ) : null}

        <details className="group mt-6 rounded-xl border border-line bg-surface-subtle p-4">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-ink-700">
            <span className="flex items-center gap-2">
              <StepNumber value={3} />
              选择参考资料和补充要求
              <span className="font-normal text-ink-500">可选</span>
            </span>
            <span className="text-xs font-medium text-brand-700 group-open:hidden">展开设置</span>
            <span className="hidden text-xs font-medium text-brand-700 group-open:inline">
              收起
            </span>
          </summary>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <Select
              label="创作工作区"
              value={workspaceId}
              onChange={(value) => void changeWorkspace(value)}
            >
              {workspaces.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
            <Select label="创作项目" value={projectId} onChange={setProjectId}>
              {projects.length === 0 ? <option value="">暂无项目</option> : null}
              {projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
            <Select
              label="内容目标"
              value={objective}
              onChange={(value) => setObjective(value as BriefObjective)}
            >
              <option value="awareness">提升品牌认知</option>
              <option value="conversion">促进转化</option>
            </Select>
            <Select
              label="核心关键词（不选则自动使用）"
              value={compatibleKeywords.some((item) => item.id === keywordId) ? keywordId : ''}
              onChange={setKeywordId}
            >
              <option value="">自动选择</option>
              {compatibleKeywords.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.term}
                </option>
              ))}
            </Select>
            <fieldset className="sm:col-span-2">
              <legend className="text-sm text-ink-700">创作参考资料</legend>
              {sources.length > 0 ? (
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {sources.map((source) => (
                    <label
                      className="flex min-h-11 cursor-pointer items-center gap-2 rounded-control border border-line bg-white px-3 text-sm text-ink-700"
                      key={source.id}
                    >
                      <input
                        checked={selectedSourceIds.includes(source.id)}
                        onChange={(event) =>
                          setSelectedSourceIds((current) =>
                            event.target.checked
                              ? [...current, source.id]
                              : current.filter((id) => id !== source.id),
                          )
                        }
                        type="checkbox"
                      />
                      {source.title}
                    </label>
                  ))}
                </div>
              ) : (
                <p className="mt-2 rounded-control bg-amber-50 p-3 text-sm text-amber-800">
                  当前项目没有已处理完成的资料。你仍可生成内容，或先
                  <Link className="mx-1 font-semibold underline" href="/know-02">
                    上传文件或添加网址
                  </Link>
                  让文章引用企业资料。
                </p>
              )}
              {sources.length > 0 ? (
                <p className="mt-2 text-xs text-ink-500">
                  默认使用全部有效资料；生成时只会检索与当前主题相关的段落。
                </p>
              ) : null}
            </fieldset>
          </div>
          <OptionalField label="目标受众" name="audience" placeholder="例如：企业市场负责人" />
          <OptionalField
            label="核心观点或补充要求"
            name="instructions"
            placeholder="例如：强调可追溯引用，避免夸张表达"
            multiline
          />
          <OptionalField label="行动引导（CTA）" name="cta" placeholder="例如：预约产品演示" />
          <p className="mt-4 text-xs text-ink-500">
            需要绑定事实证据、指定资料或设置截止时间？
            <Link className="ml-1 font-medium text-brand-700" href="/cont-02">
              使用专业模式
            </Link>
          </p>
        </details>

        {configState === 'loading' ? (
          <p className="mt-4 text-sm text-ink-500">正在准备项目配置…</p>
        ) : null}
        {configState === 'error' ? (
          <p className="mt-4 text-sm text-red-700">项目配置暂时无法加载，请刷新后重试。</p>
        ) : null}
        {configState === 'ready' && projectId && compatibleKeywords.length === 0 ? (
          <p className="mt-4 rounded-control bg-amber-50 p-3 text-sm text-amber-800">
            {canPrepareKeywords ? (
              <>当前项目没有适用于所选平台的关键词。生成时系统会根据主题自动创建。</>
            ) : (
              <>
                当前项目没有适用于所选平台的关键词，请联系管理员或前往
                <Link
                  className="mx-1 font-semibold underline"
                  href={`/str-04?project_id=${projectId}`}
                >
                  关键词管理
                </Link>
                完成配置。
              </>
            )}
          </p>
        ) : null}
        {configState === 'ready' && projectId && !hasPublishedBrand ? (
          <p className="mt-3 rounded-control bg-amber-50 p-3 text-sm text-amber-800">
            {canPrepareKeywords ? (
              <>
                当前工作区还没有已发布品牌策略。首次生成时，系统会建立一份基础策略，你可以稍后在“品牌与选题”中完善。
              </>
            ) : (
              <>当前工作区还没有已发布品牌策略，请联系管理员完成配置。</>
            )}
          </p>
        ) : null}

        <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-brand-100 bg-brand-50 px-4 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <StepNumber value={4} />
            <div>
              <p className="text-sm font-semibold text-ink-950">
                已选 {platforms.length} 个平台，可以开始生成
              </p>
              <p className="mt-1 text-xs leading-5 text-ink-500">
                系统会生成通用初稿和各平台版本；完成后直接进入内容工作区继续检查和发布。
              </p>
            </div>
          </div>
          <button
            className="min-h-12 rounded-control bg-brand-600 px-6 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={
              busy ||
              configState !== 'ready' ||
              !projectId ||
              (compatibleKeywords.length === 0 && !canPrepareKeywords) ||
              (!hasPublishedBrand && !canPrepareKeywords)
            }
            type="submit"
          >
            {busy ? '正在创建…' : '生成内容'}
          </button>
        </div>

        <div aria-live="polite" className="mt-4 min-h-6">
          {status ? (
            <p role="status" className="text-sm text-ink-700">
              {status}
            </p>
          ) : null}
          {recovery ? (
            <div className="mt-3 flex flex-wrap gap-3">
              <button
                className="text-sm font-semibold text-brand-700"
                disabled={busy}
                onClick={() => void resume()}
                type="button"
              >
                继续重试
              </button>
              {recovery.step === 'generation' ? (
                <Link
                  className="text-sm font-semibold text-brand-700"
                  href={`/cont-04?id=${recovery.packageId}`}
                >
                  查看内容任务
                </Link>
              ) : (
                <Link
                  className="text-sm font-semibold text-brand-700"
                  href={`/cont-02?id=${recovery.brief.id}`}
                >
                  查看已保存要求
                </Link>
              )}
            </div>
          ) : null}
        </div>
      </form>
    </section>
  );
}

function StepNumber({ value }: { readonly value: number }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white"
    >
      {value}
    </span>
  );
}

async function loadKeywordContext(
  projectId: string,
  signal: AbortSignal,
): Promise<{ readonly keywordSetId: string | null; readonly keywords: Keyword[] }> {
  const sets = await listKeywordSets({ projectId, status: 'active' }, signal);
  const pages = await Promise.all(
    sets.map((item) => listKeywords(item.id, { limit: 100, status: 'active' }, signal)),
  );
  return {
    keywordSetId: sets[0]?.id ?? null,
    keywords: pages
      .flatMap((item) => item.data)
      .sort((left, right) => right.priority - left.priority),
  };
}

async function loadGenerationContext(projectId: string, workspaceId: string, signal: AbortSignal) {
  const [keywordContext, publishedProfiles, sourcePage] = await Promise.all([
    loadKeywordContext(projectId, signal),
    listBrandProfiles('published', signal),
    listSources({ projectId, status: 'active', workspaceId }, signal),
  ]);
  return {
    ...keywordContext,
    hasPublishedBrand: publishedProfiles.some((item) => item.workspace_id === workspaceId),
    sources: sourcePage.items,
  };
}

function keywordSupportsPlatforms(keyword: Keyword, platforms: readonly PlatformCode[]): boolean {
  return keyword.platform_scope.some((platform) => platforms.includes(platform));
}

function briefSaveErrorMessage(error: unknown): string {
  if (!(error instanceof BriefEditorRequestError)) {
    return '创作要求保存失败，请检查网络连接后重试。';
  }
  if (error.status === 401) return '登录已失效，请重新登录后再试。';
  if (error.status === 403) return '当前账号没有创建内容的权限。';
  if (error.status === 409 && error.code === 'STATE_TRANSITION_INVALID') {
    return '当前项目、关键词或参考资料与所选平台不匹配，请刷新配置后重试。';
  }
  if (error.status === 409 && error.code === 'IDEMPOTENCY_CONFLICT') {
    return '本次创建请求与先前请求冲突，请重新提交。';
  }
  if (error.status === 422) return '创作要求未通过校验，请检查填写内容后重试。';
  return `创作要求保存失败（HTTP ${error.status}），请稍后重试。`;
}

function Select({
  children,
  label,
  name,
  onChange,
  value,
}: {
  readonly children: React.ReactNode;
  readonly label: string;
  readonly name?: string;
  readonly onChange?: (value: string) => void;
  readonly value: string;
}) {
  return (
    <label className="text-sm text-ink-700">
      {label}
      <select
        className="mt-2 h-11 w-full rounded-control border border-line bg-white px-3"
        name={name}
        onChange={onChange ? (event) => onChange(event.target.value) : undefined}
        value={value}
      >
        {children}
      </select>
    </label>
  );
}

function OptionalField({
  label,
  multiline = false,
  name,
  placeholder,
}: {
  readonly label: string;
  readonly multiline?: boolean;
  readonly name: string;
  readonly placeholder: string;
}) {
  const className = 'mt-2 w-full rounded-control border border-line bg-white px-3 py-3 text-sm';
  return (
    <label className="mt-4 block text-sm text-ink-700">
      {label}
      {multiline ? (
        <textarea
          className={`${className} min-h-24`}
          maxLength={5_000}
          name={name}
          placeholder={placeholder}
        />
      ) : (
        <input
          className="mt-2 h-11 w-full rounded-control border border-line bg-white px-3 text-sm"
          maxLength={500}
          name={name}
          placeholder={placeholder}
        />
      )}
    </label>
  );
}

function optionalText(value: FormDataEntryValue | null) {
  const text = String(value ?? '').trim();
  return text || null;
}

function readCookie(name: string) {
  const prefix = `${encodeURIComponent(name)}=`;
  const cookie = document.cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : '';
}
