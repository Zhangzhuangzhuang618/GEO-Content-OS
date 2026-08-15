'use client';

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';

import {
  getLiejuBrowserSession,
  PlatformAccountRequestError,
  startLiejuBrowserLogin,
} from './platform-account-api';
import type {
  BaijiahaoBrowserLogin,
  BaijiahaoBrowserSession,
  LiejuBrowserLoginInput,
  PlatformAccount,
} from './platform-account.schema';
import { BrowserPlatformAutomationPanel } from './browser-platform-automation-panel';

type LoginMode = 'qq' | 'password';

export function LiejuBrowserPanel({
  account,
  onClose,
}: {
  readonly account: PlatformAccount;
  readonly onClose: () => void;
}) {
  return account.capabilities['delivery_method'] === 'official_api' ? (
    <LiejuOfficialApiPanel account={account} onClose={onClose} />
  ) : (
    <LiejuBrowserGatewayPanel account={account} onClose={onClose} />
  );
}

function LiejuOfficialApiPanel({
  account,
  onClose,
}: {
  readonly account: PlatformAccount;
  readonly onClose: () => void;
}) {
  return (
    <section className="mt-5 rounded-2xl border border-brand-200 bg-white p-5 shadow-panel sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-ink-950">列举网官方 API</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-ink-500">
            API Key 已加密保存，无需浏览器登录。固定发布到广州“生活服务 /
            搬家”；接口状态不明确时会转人工确认，不会自动重复提交。
          </p>
        </div>
        <button className={secondaryButton} onClick={onClose} type="button">
          关闭
        </button>
      </div>
      <BrowserPlatformAutomationPanel account={account} />
    </section>
  );
}

function LiejuBrowserGatewayPanel({
  account,
  onClose,
}: {
  readonly account: PlatformAccount;
  readonly onClose: () => void;
}) {
  const [session, setSession] = useState<BaijiahaoBrowserSession | null>(null);
  const [login, setLogin] = useState<BaijiahaoBrowserLogin | null>(null);
  const [mode, setMode] = useState<LoginMode>('qq');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    void getLiejuBrowserSession(account.id, controller.signal)
      .then(setSession)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setMessage(
            error instanceof PlatformAccountRequestError && error.status === 404
              ? '尚未建立列举网托管会话。'
              : '读取列举网登录态失败。',
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [account.id]);

  useEffect(() => {
    if (session?.status !== 'qr_ready') return;
    const timer = setInterval(() => {
      void getLiejuBrowserSession(account.id)
        .then((next) => {
          setSession(next);
          if (next.status === 'authenticated') {
            setLogin(null);
            setMessage('QQ 扫码登录已确认；账号具备免验证码权益时可自动发布。');
          }
        })
        .catch(() => undefined);
    }, 3_000);
    return () => clearInterval(timer);
  }, [account.id, session?.status]);

  async function beginLogin(input: LiejuBrowserLoginInput) {
    if (inFlight.current) return;
    const csrf = readCookie('geo_csrf');
    if (!csrf) return setMessage('安全令牌尚未就绪，请刷新页面后重试。');
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const next = await startLiejuBrowserLogin(account, csrf, input, session?.status === 'reauth');
      setSession(next);
      setLogin(next);
      setMessage(
        next.status === 'authenticated'
          ? '列举网登录已确认。'
          : '请使用 QQ 扫描二维码。若要连接已有列举网账号，请先在列举网完成 QQ 绑定。',
      );
    } catch (error) {
      setMessage(
        error instanceof PlatformAccountRequestError && error.status === 423
          ? '列举网拒绝了用户名或密码，或要求额外人工安全验证。'
          : '启动列举网登录失败，请检查 API 与列举网浏览器 Worker。',
      );
    } finally {
      if (input.method === 'password') setPassword('');
      inFlight.current = false;
      setBusy(false);
      setLoading(false);
    }
  }

  async function refresh() {
    setBusy(true);
    try {
      const next = await getLiejuBrowserSession(account.id);
      setSession(next);
      setMessage(`登录态已核验：${sessionLabel(next.status)}。`);
    } catch {
      setMessage('实时核验失败，请检查 API 与列举网浏览器 Worker 日志。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-5 rounded-2xl border border-brand-200 bg-white p-5 shadow-panel sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-ink-950">列举网托管浏览器</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-ink-500">
            支持 QQ
            扫码和列举网用户名密码登录。官方没有手机验证码登录入口；用户名和密码只用于本次登录，不写入数据库、日志或账号配置。
          </p>
        </div>
        <button className={secondaryButton} onClick={onClose} type="button">
          关闭
        </button>
      </div>
      <div className="mt-5 rounded-xl border border-line bg-surface-subtle p-4">
        <p className="font-semibold text-ink-900">
          状态：{loading ? '读取中' : sessionLabel(session?.status ?? 'login_required')}
        </p>
        <p className="mt-1 text-xs text-ink-500">
          最近核验：{formatDateTime(session?.last_verified_at)}
        </p>
        <div className="mt-4 flex gap-2" role="tablist" aria-label="列举网登录方式">
          {(['qq', 'password'] as const).map((value) => (
            <button
              aria-selected={mode === value}
              className={mode === value ? primaryButton : secondaryButton}
              key={value}
              onClick={() => {
                setMode(value);
                setLogin(null);
                setMessage(null);
              }}
              role="tab"
              type="button"
            >
              {value === 'qq' ? 'QQ 扫码' : '账号密码'}
            </button>
          ))}
        </div>
        {mode === 'qq' ? (
          <div className="mt-4">
            <button
              className={primaryButton}
              disabled={busy}
              onClick={() => void beginLogin({ method: 'qq' })}
              type="button"
            >
              {busy ? '正在启动…' : session?.status === 'reauth' ? '重新扫码' : '生成 QQ 二维码'}
            </button>
            {login?.qr_image_data_url ? (
              <div className="mt-5 w-fit rounded-xl bg-white p-4">
                <Image
                  alt="列举网 QQ 登录二维码"
                  height={240}
                  src={login.qr_image_data_url}
                  unoptimized
                  width={240}
                />
              </div>
            ) : null}
          </div>
        ) : (
          <div className="mt-4 grid max-w-xl gap-3">
            <label className={labelClass}>
              列举网用户名
              <input
                autoComplete="username"
                className={inputClass}
                maxLength={120}
                onChange={(event) => setUsername(event.target.value)}
                value={username}
              />
            </label>
            <label className={labelClass}>
              密码
              <input
                autoComplete="current-password"
                className={inputClass}
                maxLength={256}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                value={password}
              />
            </label>
            <button
              className={primaryButton}
              disabled={busy || !username.trim() || !password}
              onClick={() =>
                void beginLogin({ method: 'password', password, username: username.trim() })
              }
              type="button"
            >
              {busy ? '正在登录…' : '账号密码登录'}
            </button>
          </div>
        )}
        <div className="mt-4">
          <button
            className={secondaryButton}
            disabled={busy}
            onClick={() => void refresh()}
            type="button"
          >
            核验登录态
          </button>
        </div>
        <p aria-live="polite" className="mt-4 text-sm text-ink-700">
          {message}
        </p>
      </div>
      <BrowserPlatformAutomationPanel account={account} />
    </section>
  );
}

function sessionLabel(status: BaijiahaoBrowserSession['status']) {
  return {
    attention_required: '需要人工处理',
    authenticated: '已登录',
    disabled: '已停用',
    login_required: '未登录',
    qr_ready: '等待扫码',
    reauth: '登录已失效',
  }[status];
}

function formatDateTime(value: string | null | undefined) {
  return value
    ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      )
    : '尚未核验';
}

function readCookie(name: string) {
  const prefix = `${encodeURIComponent(name)}=`;
  const cookie = document.cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : '';
}

const inputClass =
  'mt-1 h-10 w-full rounded-control border border-line bg-white px-3 text-sm text-ink-900';
const labelClass = 'text-sm font-medium text-ink-800';
const primaryButton =
  'h-10 w-fit rounded-control bg-brand-600 px-4 text-sm font-semibold text-white disabled:opacity-60';
const secondaryButton =
  'h-10 w-fit rounded-control border border-line bg-white px-4 text-sm font-semibold text-ink-800 disabled:opacity-60';
