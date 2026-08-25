'use client';

import Image from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getSohuBrowserSession, startSohuBrowserLogin } from './platform-account-api';
import type {
  BaijiahaoBrowserLogin,
  BaijiahaoBrowserSession,
  PlatformAccount,
  SohuBrowserLoginInput,
} from './platform-account.schema';
import { BrowserPlatformAutomationPanel } from './browser-platform-automation-panel';
import { sohuLoginErrorMessage } from './sohu-login-error';

type LoginMode = 'wechat' | 'password' | 'sms';

export function SohuBrowserPanel({
  account,
  onClose,
}: {
  readonly account: PlatformAccount;
  readonly onClose: () => void;
}) {
  const [session, setSession] = useState<BaijiahaoBrowserSession | null>(null);
  const [login, setLogin] = useState<BaijiahaoBrowserLogin | null>(null);
  const [mode, setMode] = useState<LoginMode>('wechat');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [mobile, setMobile] = useState('');
  const [imageCaptcha, setImageCaptcha] = useState('');
  const [smsCode, setSmsCode] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const inFlight = useRef(false);

  const runLogin = useCallback(
    async (input: SohuBrowserLoginInput) => {
      if (inFlight.current) return;
      const csrf = readCookie('geo_csrf');
      if (!csrf) {
        setLoading(false);
        setMessage('安全令牌尚未就绪，请刷新页面后重试。');
        return;
      }
      inFlight.current = true;
      setBusy(true);
      setMessage(null);
      try {
        const next = await startSohuBrowserLogin(
          account,
          csrf,
          input,
          session?.status === 'reauth',
        );
        setSession(next);
        setLogin(next);
        if (next.status === 'authenticated') {
          setMessage('搜狐号登录已确认，自动发布可以使用。');
        } else if (next.login_stage === 'captcha_required') {
          setMessage('请输入图形验证码，再发送手机验证码。');
        } else if (next.login_stage === 'sms_code_required') {
          setMessage('短信验证码已发送，请填写后完成登录。');
        } else {
          setMessage('请使用微信扫描二维码。二维码不会写入日志或数据库。');
        }
      } catch (error) {
        setMessage(sohuLoginErrorMessage(error));
      } finally {
        if (input.method === 'password') setPassword('');
        inFlight.current = false;
        setBusy(false);
        setLoading(false);
      }
    },
    [account, session?.status],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void getSohuBrowserSession(account.id, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setSession(next);
        setLogin(null);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setMessage('读取搜狐号登录态失败，请检查 API 与搜狐浏览器 Worker 日志。');
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
      void getSohuBrowserSession(account.id)
        .then((next) => {
          setSession(next);
          if (next.status === 'authenticated') {
            setLogin(null);
            setMessage('微信扫码登录已确认，搜狐号自动发布可以使用。');
          }
        })
        .catch(() => undefined);
    }, 3_000);
    return () => clearInterval(timer);
  }, [account.id, session?.status]);

  async function refresh() {
    setBusy(true);
    try {
      const next = await getSohuBrowserSession(account.id);
      setSession(next);
      setMessage(`登录态已核验：${sessionLabel(next.status)}。`);
    } catch {
      setMessage('实时核验失败，请检查 API 与搜狐浏览器 Worker 日志。');
    } finally {
      setBusy(false);
    }
  }

  const validMobile = /^1[3-9][0-9]{9}$/u.test(mobile);

  return (
    <section className="mt-5 rounded-2xl border border-brand-200 bg-white p-5 shadow-panel sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-ink-950">搜狐号托管浏览器</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-ink-500">
            支持微信扫码、账号密码和中国大陆手机验证码登录。账号、密码、手机号及验证码只用于本次登录，不写入数据库、日志或账号配置。
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

        <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="搜狐号登录方式">
          {(['wechat', 'password', 'sms'] as const).map((value) => (
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
              {{ password: '账号密码', sms: '手机验证码', wechat: '微信扫码' }[value]}
            </button>
          ))}
        </div>

        {mode === 'wechat' ? (
          <div className="mt-4">
            <button
              className={primaryButton}
              disabled={busy}
              onClick={() => void runLogin({ method: 'wechat' })}
              type="button"
            >
              {busy ? '正在启动…' : session?.status === 'reauth' ? '重新扫码' : '生成微信二维码'}
            </button>
            {login?.qr_image_data_url ? (
              <div className="mt-5 w-fit rounded-xl bg-white p-4">
                <Image
                  alt="搜狐号微信登录二维码"
                  height={240}
                  src={login.qr_image_data_url}
                  unoptimized
                  width={240}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        {mode === 'password' ? (
          <div className="mt-4 grid max-w-xl gap-3">
            <label className={labelClass}>
              邮箱或手机号
              <input
                autoComplete="username"
                className={inputClass}
                maxLength={120}
                onChange={(event) => setIdentifier(event.target.value)}
                value={identifier}
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
            <TermsCheckbox checked={acceptedTerms} onChange={setAcceptedTerms} />
            <button
              className={primaryButton}
              disabled={busy || !identifier.trim() || !password || !acceptedTerms}
              onClick={() =>
                void runLogin({
                  accepted_terms: true,
                  account: identifier.trim(),
                  method: 'password',
                  password,
                })
              }
              type="button"
            >
              {busy ? '正在登录…' : '账号密码登录'}
            </button>
          </div>
        ) : null}

        {mode === 'sms' ? (
          <div className="mt-4 grid max-w-xl gap-3">
            <label className={labelClass}>
              中国大陆手机号
              <input
                autoComplete="tel"
                className={inputClass}
                inputMode="numeric"
                maxLength={11}
                onChange={(event) => setMobile(event.target.value.replace(/\D/gu, ''))}
                value={mobile}
              />
            </label>
            <button
              className={secondaryButton}
              disabled={busy || !validMobile}
              onClick={() => void runLogin({ method: 'sms_prepare', mobile })}
              type="button"
            >
              获取图形验证码
            </button>
            {login?.captcha_image_data_url ? (
              <div className="flex flex-wrap items-end gap-3">
                <Image
                  alt="搜狐手机登录图形验证码"
                  className="rounded border border-line bg-white"
                  height={48}
                  src={login.captcha_image_data_url}
                  unoptimized
                  width={120}
                />
                <label className={labelClass}>
                  图形验证码
                  <input
                    autoComplete="off"
                    className={inputClass}
                    maxLength={12}
                    onChange={(event) => setImageCaptcha(event.target.value)}
                    value={imageCaptcha}
                  />
                </label>
              </div>
            ) : null}
            <TermsCheckbox checked={acceptedTerms} onChange={setAcceptedTerms} />
            <button
              className={primaryButton}
              disabled={busy || !validMobile || !imageCaptcha.trim() || !acceptedTerms}
              onClick={() =>
                void runLogin({
                  accepted_terms: true,
                  image_captcha: imageCaptcha.trim(),
                  method: 'sms_send',
                  mobile,
                })
              }
              type="button"
            >
              {busy ? '正在发送…' : '发送短信验证码'}
            </button>
            {login?.login_stage === 'sms_code_required' ? (
              <>
                <label className={labelClass}>
                  短信验证码
                  <input
                    autoComplete="one-time-code"
                    className={inputClass}
                    inputMode="numeric"
                    maxLength={8}
                    onChange={(event) => setSmsCode(event.target.value.replace(/\D/gu, ''))}
                    value={smsCode}
                  />
                </label>
                <button
                  className={primaryButton}
                  disabled={busy || !/^[0-9]{4,8}$/u.test(smsCode) || !acceptedTerms}
                  onClick={() =>
                    void runLogin({
                      accepted_terms: true,
                      method: 'sms_verify',
                      mobile,
                      sms_code: smsCode,
                    })
                  }
                  type="button"
                >
                  {busy ? '正在验证…' : '完成手机登录'}
                </button>
              </>
            ) : null}
          </div>
        ) : null}

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

function TermsCheckbox({
  checked,
  onChange,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 text-sm text-ink-700">
      <input
        checked={checked}
        className="mt-1"
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      我已阅读并同意搜狐《用户服务协议》和《隐私政策》
    </label>
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
