'use client';

import { useEffect, useState, type FormEvent } from 'react';

import { acceptInvitation, InvitationAcceptRequestError } from './invitation-accept-api';

const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;

export function InvitationAcceptForm() {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get('token')?.trim() ?? '');
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !INVITATION_TOKEN_PATTERN.test(token)) {
      setMessage('邀请链接无效，请联系邀请人重新发送。');
      return;
    }
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }
    const form = new FormData(event.currentTarget);
    const displayName = String(form.get('display_name') ?? '').trim();
    const password = String(form.get('password') ?? '');
    const confirmation = String(form.get('password_confirmation') ?? '');
    if (password !== confirmation) {
      setMessage('两次输入的密码不一致。');
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      await acceptInvitation({ displayName, password, token }, csrf);
      window.location.assign('/dash-01');
    } catch (error) {
      setMessage(invitationErrorMessage(error));
      setBusy(false);
    }
  }

  if (token === null) {
    return <p className="mt-8 text-sm text-ink-500">正在读取邀请信息…</p>;
  }

  if (!INVITATION_TOKEN_PATTERN.test(token)) {
    return (
      <div className="mt-8 rounded-2xl bg-red-50 p-5">
        <h2 className="font-semibold text-red-900">邀请链接无效</h2>
        <p className="mt-2 text-sm leading-6 text-red-800">请联系邀请人重新发送企业邀请。</p>
      </div>
    );
  }

  return (
    <form className="mt-8" onSubmit={submit}>
      <label className="block text-sm font-medium text-ink-700" htmlFor="invitation-name">
        姓名
      </label>
      <input
        autoComplete="name"
        className={controlClass}
        id="invitation-name"
        maxLength={80}
        name="display_name"
        required
      />

      <label className="mt-5 block text-sm font-medium text-ink-700" htmlFor="invitation-password">
        账号密码
      </label>
      <input
        aria-describedby="invitation-password-hint"
        autoComplete="new-password"
        className={controlClass}
        id="invitation-password"
        maxLength={128}
        minLength={12}
        name="password"
        required
        type="password"
      />
      <p className="mt-2 text-xs leading-5 text-ink-500" id="invitation-password-hint">
        至少 12 个字符。新账号请设置密码；已有账号请填写当前密码。
      </p>

      <label
        className="mt-5 block text-sm font-medium text-ink-700"
        htmlFor="invitation-password-confirmation"
      >
        再次输入密码
      </label>
      <input
        autoComplete="new-password"
        className={controlClass}
        id="invitation-password-confirmation"
        maxLength={128}
        minLength={12}
        name="password_confirmation"
        required
        type="password"
      />

      <div aria-live="assertive" className="mt-5 min-h-10">
        {message ? (
          <p className="rounded-control bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
            {message}
          </p>
        ) : null}
      </div>

      <button
        className="mt-3 flex h-12 w-full items-center justify-center rounded-control bg-brand-600 px-5 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-brand-100"
        disabled={busy}
        type="submit"
      >
        {busy ? '正在接受邀请…' : '接受邀请并进入企业'}
      </button>
    </form>
  );
}

function invitationErrorMessage(error: unknown): string {
  if (!(error instanceof InvitationAcceptRequestError)) {
    return '浏览器无法发起安全请求，请刷新页面后重试。';
  }
  if (error.status === 401) return '密码不正确；已有账号请填写当前密码。';
  if (error.status === 403) return '安全校验失败，请刷新页面后重试。';
  if (error.status === 404) return '邀请已失效、已使用或企业不可用，请联系邀请人重新发送。';
  if (error.status === 409) return '邀请状态已经变化，请刷新页面或联系邀请人确认。';
  if (error.status >= 500) return '邀请服务暂时不可用，请稍后重试。';
  return '无法接受邀请，请检查填写内容后重试。';
}

function readCookie(name: string): string {
  const prefix = `${encodeURIComponent(name)}=`;
  const cookie = document.cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : '';
}

const controlClass =
  'mt-2 block h-12 w-full rounded-control border border-line bg-white px-3.5 text-base text-ink-950 transition hover:border-ink-500 focus:border-brand-500 focus:outline-none';
