'use client';

import { useEffect, useState } from 'react';
import { listAvailableTenants } from '../auth-02/tenant-api';
import type { TenantRole as ActiveTenantRole } from '../auth-02/tenant.schema';
import {
  changeMemberState,
  inviteMember,
  loadMemberAdmin,
  MemberAdminRequestError,
  updateMember,
  type Member,
  type TenantRole,
  type Workspace,
} from './member-admin-api';
import type { Invitation } from './member-admin.schema';

const MANAGER_ROLES = new Set<ActiveTenantRole>(['tenant_owner', 'tenant_admin']);
const ROLES: readonly [TenantRole, string][] = [
  ['tenant_owner', '租户所有者'],
  ['tenant_admin', '租户管理员'],
  ['strategy_editor', '策略编辑'],
  ['content_editor', '内容编辑'],
  ['reviewer', '审核员'],
  ['publisher', '发布员'],
  ['analyst', '分析员'],
  ['viewer', '只读成员'],
];

interface Draft {
  readonly role: TenantRole;
  readonly workspaceIds: string[];
}

export function MemberAdministration() {
  const [state, setState] = useState<'loading' | 'ready' | 'permission' | 'error'>('loading');
  const [actorRole, setActorRole] = useState<ActiveTenantRole | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [filters, setFilters] = useState(() => readFilters());
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<TenantRole>('viewer');
  const [inviteWorkspaces, setInviteWorkspaces] = useState<string[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      setState('loading');
      try {
        const tenants = await listAvailableTenants(controller.signal);
        const activeRole = tenants.find((tenant) => tenant.is_active)?.role_code ?? null;
        if (!activeRole || !MANAGER_ROLES.has(activeRole)) {
          setState('permission');
          return;
        }
        setActorRole(activeRole);
        const loaded = await loadMemberAdmin(filters, controller.signal);
        if (controller.signal.aborted) return;
        setMembers(loaded.members);
        setInvitations(loaded.invitations);
        setWorkspaces(loaded.workspaces);
        setDrafts(Object.fromEntries(loaded.members.map((member) => [member.id, toDraft(member)])));
        setState('ready');
      } catch (error) {
        if (controller.signal.aborted) return;
        setState(
          error instanceof MemberAdminRequestError && error.status === 403 ? 'permission' : 'error',
        );
      }
    })();
    return () => controller.abort();
  }, [filters]);

  function applyFilters(next: typeof filters) {
    setFilters(next);
    const query = new URLSearchParams();
    if (next.search) query.set('search', next.search);
    if (next.role) query.set('role', next.role);
    if (next.status) query.set('status', next.status);
    window.history.replaceState(null, '', `/set-01${query.size ? `?${query}` : ''}`);
  }

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    const email = inviteEmail.trim();
    if (!email) return;
    const csrf = readCookie('geo_csrf');
    if (!csrf) return setMessage('安全令牌尚未就绪，请刷新页面后重试。');
    setBusyId('invite');
    setMessage(null);
    try {
      const created = await inviteMember(
        { email, role: inviteRole, workspaceIds: inviteWorkspaces },
        csrf,
      );
      setInvitations((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      setInviteEmail('');
      setMessage('邀请已创建。');
    } catch {
      setMessage('邀请失败；请检查邮箱、角色、工作区范围或重复邀请。');
    } finally {
      setBusyId(null);
    }
  }

  async function save(member: Member) {
    const draft = drafts[member.id];
    if (!draft) return;
    await mutate(member, () => updateMember(member, draft, requireCsrf()), '成员信息已更新。');
  }

  async function changeState(member: Member, action: 'disable' | 'restore') {
    if (action === 'disable' && isLastOwner(member, members)) return;
    await mutate(
      member,
      () => changeMemberState(member, action, requireCsrf()),
      action === 'disable' ? '成员已禁用。' : '成员已恢复。',
    );
  }

  async function mutate(member: Member, work: () => Promise<Member>, success: string) {
    try {
      setBusyId(member.id);
      setMessage(null);
      const updated = await work();
      setMembers((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setDrafts((current) => ({ ...current, [updated.id]: toDraft(updated) }));
      setMessage(success);
    } catch {
      setMessage('操作失败；成员版本、权限或最后一名 Owner 约束可能已变化，请刷新后重试。');
    } finally {
      setBusyId(null);
    }
  }

  if (state === 'loading')
    return <StatePanel busy title="正在加载成员" text="正在读取成员、邀请与工作区范围。" />;
  if (state === 'permission')
    return <StatePanel title="无权管理成员" text="该页面仅对租户所有者和租户管理员开放。" />;
  if (state === 'error')
    return <StatePanel title="无法加载成员" text="请检查网络或权限后刷新页面。" />;

  const availableRoles =
    actorRole === 'tenant_owner' ? ROLES : ROLES.filter(([role]) => role !== 'tenant_owner');

  return (
    <div className="space-y-6">
      <form className="rounded-2xl border border-line bg-white p-5 shadow-panel" onSubmit={invite}>
        <h2 className="text-lg font-semibold text-ink-950">邀请成员</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <Field label="邮箱" name="invite-email">
            <input
              id="invite-email"
              className={controlClass}
              onChange={(event) => setInviteEmail(event.currentTarget.value)}
              required
              type="email"
              value={inviteEmail}
            />
          </Field>
          <Field label="角色" name="invite-role">
            <select
              id="invite-role"
              className={controlClass}
              onChange={(event) => setInviteRole(event.currentTarget.value as TenantRole)}
              value={inviteRole}
            >
              {availableRoles.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex items-end">
            <button className={primaryButton} disabled={busyId === 'invite'} type="submit">
              {busyId === 'invite' ? '正在邀请…' : '发送邀请'}
            </button>
          </div>
        </div>
        <WorkspaceChecks
          legend="工作区范围（不选表示全部工作区）"
          selected={inviteWorkspaces}
          setSelected={setInviteWorkspaces}
          workspaces={workspaces}
        />
      </form>

      <section className="rounded-2xl border border-line bg-white p-5 shadow-panel">
        <h2 className="text-lg font-semibold text-ink-950">成员列表</h2>
        <form
          className="mt-4 grid gap-3 sm:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            applyFilters({ ...filters, search: searchDraft.trim() });
          }}
        >
          <input
            aria-label="搜索成员"
            className={controlClass}
            onChange={(event) => setSearchDraft(event.currentTarget.value)}
            placeholder="姓名或邮箱"
            value={searchDraft}
          />
          <select
            aria-label="角色筛选"
            className={controlClass}
            onChange={(event) => applyFilters({ ...filters, role: event.currentTarget.value })}
            value={filters.role}
          >
            <option value="">全部角色</option>
            {ROLES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            aria-label="状态筛选"
            className={controlClass}
            onChange={(event) => applyFilters({ ...filters, status: event.currentTarget.value })}
            value={filters.status}
          >
            <option value="">全部状态</option>
            <option value="active">Active</option>
            <option value="disabled">已禁用</option>
            <option value="invited">待接受</option>
          </select>
          <button className={secondaryButton} type="submit">
            搜索
          </button>
        </form>
        {members.length === 0 ? (
          <p className="mt-6 text-sm text-ink-500">没有符合条件的成员。</p>
        ) : (
          <div className="mt-5 space-y-4">
            {members.map((member) => {
              const draft = drafts[member.id] ?? toDraft(member);
              const protectedOwner = isLastOwner(member, members);
              const adminCannotManageOwner =
                actorRole === 'tenant_admin' && member.role_code === 'tenant_owner';
              return (
                <article className="rounded-xl border border-line p-4" key={member.id}>
                  <div className="flex flex-wrap justify-between gap-3">
                    <div>
                      <h3 className="font-semibold text-ink-950">{member.display_name}</h3>
                      <p className="text-sm text-ink-500">{member.email}</p>
                    </div>
                    <span className="text-sm font-medium text-brand-700">
                      {statusLabel(member.status)} · v{member.version}
                    </span>
                  </div>
                  <div className="mt-4 grid gap-4 md:grid-cols-[14rem_1fr_auto]">
                    <Field label="角色" name={`role-${member.id}`}>
                      <select
                        className={controlClass}
                        disabled={adminCannotManageOwner || member.status === 'invited'}
                        id={`role-${member.id}`}
                        onChange={(event) => {
                          const role = event.currentTarget.value as TenantRole;
                          setDrafts((current) => ({
                            ...current,
                            [member.id]: {
                              ...draft,
                              role,
                            },
                          }));
                        }}
                        value={draft.role}
                      >
                        {availableRoles.map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <WorkspaceChecks
                      compact
                      legend="工作区范围"
                      selected={draft.workspaceIds}
                      setSelected={(workspaceIds) =>
                        setDrafts((current) => ({
                          ...current,
                          [member.id]: { ...draft, workspaceIds },
                        }))
                      }
                      workspaces={workspaces}
                    />
                    <div className="flex items-end gap-2">
                      <button
                        className={secondaryButton}
                        disabled={
                          busyId === member.id ||
                          adminCannotManageOwner ||
                          (protectedOwner && draft.role !== 'tenant_owner')
                        }
                        onClick={() => void save(member)}
                        type="button"
                      >
                        保存
                      </button>
                      {member.status === 'disabled' ? (
                        <button
                          className={primaryButton}
                          disabled={busyId === member.id || adminCannotManageOwner}
                          onClick={() => void changeState(member, 'restore')}
                          type="button"
                        >
                          恢复
                        </button>
                      ) : (
                        <button
                          className={dangerButton}
                          disabled={
                            busyId === member.id ||
                            adminCannotManageOwner ||
                            protectedOwner ||
                            member.status !== 'active'
                          }
                          onClick={() => void changeState(member, 'disable')}
                          title={protectedOwner ? '最后一名 active Owner 不可禁用' : undefined}
                          type="button"
                        >
                          禁用
                        </button>
                      )}
                    </div>
                  </div>
                  {protectedOwner ? (
                    <p className="mt-3 text-sm font-medium text-red-700">
                      最后一名 active Owner 不可禁用或降级。
                    </p>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-line bg-white p-5 shadow-panel">
        <h2 className="text-lg font-semibold text-ink-950">邀请记录</h2>
        {invitations.length === 0 ? (
          <p className="mt-4 text-sm text-ink-500">暂无邀请。</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[42rem] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-ink-500">
                  <th className="py-3">邮箱</th>
                  <th>角色</th>
                  <th>状态</th>
                  <th>到期时间</th>
                  <th>工作区范围</th>
                </tr>
              </thead>
              <tbody>
                {invitations.map((invitation) => (
                  <tr className="border-b border-line last:border-0" key={invitation.id}>
                    <td className="py-3 font-medium text-ink-950">{invitation.email}</td>
                    <td>{roleLabel(invitation.role_code)}</td>
                    <td>{invitationStatusLabel(invitation.status)}</td>
                    <td>{new Date(invitation.expires_at).toLocaleString('zh-CN')}</td>
                    <td>{scopeLabel(invitation.workspace_scope.workspace_ids, workspaces)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div aria-live="polite" className="min-h-10">
        {message ? (
          <p className="rounded-control bg-brand-50 px-3 py-2 text-sm text-brand-700" role="status">
            {message}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function WorkspaceChecks({
  compact = false,
  legend,
  selected,
  setSelected,
  workspaces,
}: {
  compact?: boolean;
  legend: string;
  selected: string[];
  setSelected(value: string[]): void;
  workspaces: Workspace[];
}) {
  return (
    <fieldset className={compact ? '' : 'mt-4'}>
      <legend className="text-sm font-medium text-ink-700">{legend}</legend>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
        {workspaces.map((workspace) => (
          <label className="flex items-center gap-2 text-sm text-ink-700" key={workspace.id}>
            <input
              checked={selected.includes(workspace.id)}
              onChange={(event) =>
                setSelected(
                  event.currentTarget.checked
                    ? [...selected, workspace.id]
                    : selected.filter((id) => id !== workspace.id),
                )
              }
              type="checkbox"
            />
            {workspace.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Field({
  children,
  label,
  name,
}: {
  children: React.ReactNode;
  label: string;
  name: string;
}) {
  return (
    <div>
      <label className="text-sm font-medium text-ink-700" htmlFor={name}>
        {label}
      </label>
      {children}
    </div>
  );
}
function StatePanel({
  busy = false,
  text,
  title,
}: {
  busy?: boolean;
  text: string;
  title: string;
}) {
  return (
    <section
      aria-busy={busy}
      className="rounded-2xl border border-line bg-white p-8 text-center shadow-panel"
    >
      <h2 className="text-xl font-semibold text-ink-950">{title}</h2>
      <p className="mt-3 text-sm text-ink-500">{text}</p>
    </section>
  );
}
function toDraft(member: Member): Draft {
  return { role: member.role_code, workspaceIds: member.workspace_scope.workspace_ids ?? [] };
}
function isLastOwner(member: Member, members: Member[]) {
  return (
    member.role_code === 'tenant_owner' &&
    member.status === 'active' &&
    members.filter((item) => item.role_code === 'tenant_owner' && item.status === 'active')
      .length === 1
  );
}
function statusLabel(status: Member['status']) {
  return status === 'active' ? 'Active' : status === 'disabled' ? '已禁用' : '待接受';
}
function invitationStatusLabel(status: Invitation['status']) {
  return { accepted: '已接受', expired: '已过期', pending: '待接受', revoked: '已撤销' }[status];
}
function roleLabel(role: TenantRole) {
  return ROLES.find(([value]) => value === role)?.[1] ?? role;
}
function scopeLabel(ids: string[] | undefined, workspaces: Workspace[]) {
  return !ids?.length
    ? '全部工作区'
    : ids.map((id) => workspaces.find((workspace) => workspace.id === id)?.name ?? id).join('、');
}
function readFilters() {
  if (typeof window === 'undefined') return { role: '', search: '', status: '' };
  const query = new URLSearchParams(window.location.search);
  return {
    role: query.get('role') ?? '',
    search: query.get('search') ?? '',
    status: query.get('status') ?? '',
  };
}
function readCookie(name: string) {
  const prefix = `${encodeURIComponent(name)}=`;
  const cookie = document.cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : '';
}
function requireCsrf() {
  const csrf = readCookie('geo_csrf');
  if (!csrf) throw new Error('Missing CSRF token');
  return csrf;
}

const controlClass =
  'mt-2 block h-11 w-full rounded-control border border-line bg-white px-3 text-sm text-ink-950 focus:border-brand-500 focus:outline-2 focus:outline-offset-2 disabled:bg-surface-subtle';
const primaryButton =
  'h-11 rounded-control bg-brand-600 px-5 text-sm font-semibold text-white focus:outline-2 focus:outline-offset-2 disabled:opacity-60';
const secondaryButton =
  'h-11 rounded-control border border-line bg-white px-4 text-sm font-semibold text-ink-700 focus:outline-2 focus:outline-offset-2 disabled:opacity-60';
const dangerButton =
  'h-11 rounded-control border border-red-300 bg-white px-4 text-sm font-semibold text-red-700 focus:outline-2 focus:outline-offset-2 disabled:opacity-60';
