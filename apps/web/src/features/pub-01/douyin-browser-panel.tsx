'use client';

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';

import {
  getDouyinBrowserSession,
  PlatformAccountRequestError,
  startDouyinBrowserLogin,
} from './platform-account-api';
import type {
  DouyinBrowserLogin,
  DouyinBrowserLoginInput,
  DouyinBrowserSession,
  PlatformAccount,
} from './platform-account.schema';
import { BrowserPlatformAutomationPanel } from './browser-platform-automation-panel';

export function DouyinBrowserPanel({
  account,
  onClose,
}: {
  readonly account: PlatformAccount;
  readonly onClose: () => void;
}) {
  const [session, setSession] = useState<DouyinBrowserSession | null>(null);
  const [login, setLogin] = useState<DouyinBrowserLogin | null>(null);
  const [smsCode, setSmsCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    void getDouyinBrowserSession(account.id, controller.signal)
      .then(setSession)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setMessage(
            error instanceof PlatformAccountRequestError && error.status === 404
              ? '尚未建立抖音托管会话。'
              : '读取抖音登录态失败。',
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [account.id]);

  useEffect(() => {
    const waitingForPrimaryQr = session?.status === 'qr_ready';
    const waitingForOriginalDeviceQr =
      session?.status === 'attention_required' &&
      login?.verification?.challenge_type === 'original_device_scan' &&
      Boolean(login.qr_image_data_url);
    if (!waitingForPrimaryQr && !waitingForOriginalDeviceQr) return;
    const timer = setInterval(() => {
      void getDouyinBrowserSession(account.id)
        .then((next) => {
          setSession(next);
          if (next.status === 'authenticated') {
            setLogin(null);
            setMessage('抖音扫码登录已确认。');
          } else if (next.status === 'attention_required') {
            if (next.verification?.challenge_type !== 'original_device_scan') setLogin(null);
            setMessage('抖音要求二次验证，请在下方选择短信验证或原设备扫码。');
          }
        })
        .catch(() => undefined);
    }, 3_000);
    return () => clearInterval(timer);
  }, [account.id, login?.qr_image_data_url, login?.verification?.challenge_type, session?.status]);

  async function beginLogin() {
    if (inFlight.current) return;
    const csrf = readCookie('geo_csrf');
    if (!csrf) return setMessage('安全令牌尚未就绪，请刷新页面后重试。');
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const next = await startDouyinBrowserLogin(account, csrf, session?.status === 'reauth');
      setSession(next);
      setLogin(next);
      setMessage(next.status === 'authenticated' ? '抖音登录已确认。' : '请使用抖音扫描二维码。');
    } catch (error) {
      const latest = await getDouyinBrowserSession(account.id).catch(() => null);
      if (latest) setSession(latest);
      setMessage(
        error instanceof PlatformAccountRequestError &&
          (error.status === 423 || error.details?.['reason'] === 'CAPTCHA_REQUIRED')
          ? '抖音要求二次验证，请使用下方验证方式继续。'
          : error instanceof PlatformAccountRequestError &&
              error.code === 'PLATFORM_ACCOUNT_VERSION_CONFLICT'
            ? '账号状态刚刚发生变化，请再次点击生成二维码。'
            : '启动抖音登录失败，请检查 API 与抖音浏览器 Worker。',
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
      setLoading(false);
    }
  }

  async function continueVerification(input: DouyinBrowserLoginInput) {
    if (inFlight.current) return;
    const csrf = readCookie('geo_csrf');
    if (!csrf) return setMessage('安全令牌尚未就绪，请刷新页面后重试。');
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const next = await startDouyinBrowserLogin(account, csrf, account.status === 'reauth', input);
      setSession(next);
      setLogin(next);
      if (next.status === 'authenticated') {
        setSmsCode('');
        setLogin(null);
        setMessage('抖音二次验证已完成，登录快照已安全保存。');
      } else if (input.method === 'verification_sms_send') {
        setMessage('短信验证码已按你的操作发送，请输入收到的验证码。');
      } else if (input.method === 'verification_device_qr') {
        setMessage('请使用原设备扫描下方二次验证二维码。');
      } else {
        setMessage('验证码尚未通过，请核对后重试。');
      }
    } catch (error) {
      const latest = await getDouyinBrowserSession(account.id).catch(() => null);
      if (latest) setSession(latest);
      setMessage(
        error instanceof PlatformAccountRequestError && error.status === 423
          ? '二次验证页面未完成或页面结构已变化，请先核验最新诊断。'
          : '二次验证操作失败，请稍后重试。',
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function refresh() {
    setBusy(true);
    try {
      const next = await getDouyinBrowserSession(account.id);
      setSession(next);
      setMessage(`登录态已核验：${sessionLabel(next.status)}。`);
    } catch {
      setMessage('实时核验失败，请检查 API 与抖音浏览器 Worker 日志。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-5 rounded-2xl border border-brand-200 bg-white p-5 shadow-panel sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-ink-950">抖音图文自动发布</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-ink-500">
            系统生成 3:4 图文卡片并通过独立托管浏览器发布。只声明实际使用的 AI
            辅助，不会自动勾选原创。
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
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            className={primaryButton}
            disabled={busy}
            onClick={() => void beginLogin()}
            type="button"
          >
            {busy ? '正在启动…' : session?.status === 'reauth' ? '重新扫码' : '生成登录二维码'}
          </button>
          <button
            className={secondaryButton}
            disabled={busy}
            onClick={() => void refresh()}
            type="button"
          >
            核验登录态
          </button>
        </div>
        {login?.qr_image_data_url ? (
          <div className="mt-5 w-fit rounded-xl bg-white p-4">
            <Image
              alt="抖音登录二维码"
              height={240}
              src={login.qr_image_data_url}
              unoptimized
              width={240}
            />
          </div>
        ) : null}
        {session?.status === 'attention_required' && session.verification ? (
          <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
            <h3 className="font-semibold text-ink-900">需要完成二次验证</h3>
            <p className="mt-1 text-sm leading-6 text-ink-700">
              类型：{verificationLabel(session.verification.challenge_type)}；页面：
              {session.verification.page_origin}
              {session.verification.page_path}
            </p>
            <p className="mt-1 text-xs text-ink-500">
              二次验证诊断证据已安全保存；页面截图不作为操作画面展示，请使用下方验证方式继续。
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {session.verification.available_methods.includes('original_device_scan') ? (
                <button
                  className={secondaryButton}
                  disabled={busy}
                  onClick={() => void continueVerification({ method: 'verification_device_qr' })}
                  type="button"
                >
                  获取原设备验证二维码
                </button>
              ) : null}
              {session.verification.available_methods.includes('sms_code') &&
              !session.verification.has_code_input ? (
                <button
                  className={secondaryButton}
                  disabled={busy}
                  onClick={() => void continueVerification({ method: 'verification_sms_send' })}
                  type="button"
                >
                  发送短信验证码
                </button>
              ) : null}
            </div>
            {session.verification.has_code_input ? (
              <div className="mt-4 flex flex-wrap items-end gap-2">
                <label className="grid gap-1 text-sm font-medium text-ink-800">
                  短信验证码
                  <input
                    autoComplete="one-time-code"
                    className="h-10 w-48 rounded-control border border-line bg-white px-3"
                    inputMode="numeric"
                    maxLength={8}
                    onChange={(event) => setSmsCode(event.target.value.replace(/\D/gu, ''))}
                    value={smsCode}
                  />
                </label>
                <button
                  className={primaryButton}
                  disabled={busy || !/^[0-9]{4,8}$/u.test(smsCode)}
                  onClick={() =>
                    void continueVerification({
                      method: 'verification_sms_verify',
                      sms_code: smsCode,
                    })
                  }
                  type="button"
                >
                  提交验证码
                </button>
              </div>
            ) : null}
            {session.verification.challenge_type === 'visual_captcha' ? (
              <p className="mt-4 text-sm leading-6 text-amber-900">
                当前页面是交互式验证码，系统不会识别、破解或绕过。请重新扫码，或在页面提供短信/原设备方式后再继续。
              </p>
            ) : null}
          </div>
        ) : null}
        <p aria-live="polite" className="mt-4 text-sm text-ink-700">
          {message}
        </p>
      </div>
      <BrowserPlatformAutomationPanel account={account} />
    </section>
  );
}

function sessionLabel(status: DouyinBrowserSession['status']) {
  return {
    attention_required: '需要人工处理',
    authenticated: '已登录',
    disabled: '已停用',
    login_required: '未登录',
    qr_ready: '等待扫码',
    reauth: '登录已失效',
  }[status];
}

function verificationLabel(
  type: NonNullable<DouyinBrowserSession['verification']>['challenge_type'],
) {
  return {
    identity_choice: '身份验证方式选择',
    original_device_scan: '原设备扫码',
    sms_code: '短信验证码',
    sms_send: '短信验证',
    unknown: '未知安全验证',
    visual_captcha: '交互式验证码',
  }[type];
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

const primaryButton =
  'h-10 w-fit rounded-control bg-brand-600 px-4 text-sm font-semibold text-white disabled:opacity-60';
const secondaryButton =
  'h-10 w-fit rounded-control border border-line bg-white px-4 text-sm font-semibold text-ink-800 disabled:opacity-60';
