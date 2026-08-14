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
  PlatformAccount,
} from './platform-account.schema';

export function LiejuBrowserPanel({
  account,
  onClose,
}: {
  readonly account: PlatformAccount;
  readonly onClose: () => void;
}) {
  const [session, setSession] = useState<BaijiahaoBrowserSession | null>(null);
  const [login, setLogin] = useState<BaijiahaoBrowserLogin | null>(null);
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

  async function beginLogin() {
    if (inFlight.current) return;
    const csrf = readCookie('geo_csrf');
    if (!csrf) return setMessage('安全令牌尚未就绪，请刷新页面后重试。');
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const next = await startLiejuBrowserLogin(account, csrf, session?.status === 'reauth');
      setSession(next);
      setLogin(next);
      setMessage(
        next.status === 'authenticated'
          ? '当前列举网浏览器会话仍然有效。'
          : '请使用 QQ 扫描二维码。若要连接已有列举网账号，请先在列举网完成 QQ 绑定。',
      );
    } catch (error) {
      setMessage(
        error instanceof PlatformAccountRequestError && error.status === 423
          ? '列举网要求验证码、账号选择或人工安全验证，请查看浏览器 Worker 诊断截图。'
          : '启动列举网扫码登录失败，请检查列举网浏览器 Worker。',
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
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
            使用 QQ 扫码建立独立登录态；系统不保存列举网或 QQ
            密码。免费账号遇到腾讯验证码时会转人工，只有免验证码套餐或发帖包允许无人值守提交。
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
            {busy ? '正在启动…' : session?.status === 'reauth' ? '重新扫码' : 'QQ 扫码登录'}
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
              alt="列举网 QQ 登录二维码"
              height={240}
              src={login.qr_image_data_url}
              unoptimized
              width={240}
            />
          </div>
        ) : null}
        <p aria-live="polite" className="mt-4 text-sm text-ink-700">
          {message}
        </p>
      </div>
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

const primaryButton =
  'h-10 rounded-control bg-brand-600 px-4 text-sm font-semibold text-white disabled:opacity-60';
const secondaryButton =
  'h-10 rounded-control border border-line bg-white px-4 text-sm font-semibold text-ink-800 disabled:opacity-60';
