'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { returnPathFromSearch, tenantEntryPath } from '../auth-navigation';
import { login, requestPasswordReset } from './auth-api';
import { LoginFormSchema, type LoginFormValues } from './login.schema';

const GENERIC_LOGIN_ERROR = '邮箱或密码不正确，请重试。';
const GENERIC_RESET_MESSAGE = '如果该邮箱已注册，你将收到密码重置邮件。';

export function LoginForm() {
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [resetMessage, setResetMessage] = useState<string | null>(null);
  const [sessionMessage, setSessionMessage] = useState<string | null>(null);
  const [isResetting, setIsResetting] = useState(false);
  const {
    clearErrors,
    formState: { errors, isSubmitting },
    getValues,
    handleSubmit,
    register,
    setError,
    setFocus,
    setValue,
  } = useForm<LoginFormValues>({
    defaultValues: { csrf: '', email: '', password: '', remember_me: false },
  });
  const emailRegistration = register('email');

  useEffect(() => {
    setValue('csrf', readCookie('geo_csrf'), { shouldValidate: false });
    const reason = new URLSearchParams(window.location.search).get('reason');
    if (reason === 'session_expired') {
      setSessionMessage('登录已过期，请重新登录。完成后将返回原页面。');
    } else if (reason === 'switch_account') {
      setSessionMessage('已退出原账号，请登录要切换到的账号。');
    } else if (reason === 'logged_out') {
      setSessionMessage('你已安全退出登录。');
    }
  }, [setValue]);

  const submit = handleSubmit(async (values) => {
    clearErrors();
    setFormMessage(null);
    setResetMessage(null);
    const parsed = LoginFormSchema.safeParse(values);
    if (!parsed.success) {
      const fields = parsed.error.flatten().fieldErrors;
      if (fields.email?.[0]) setError('email', { message: fields.email[0] });
      if (fields.password?.[0]) setError('password', { message: fields.password[0] });
      if (fields.csrf?.[0]) setFormMessage(fields.csrf[0]);
      return;
    }

    try {
      await login(parsed.data);
      window.location.assign(tenantEntryPath(returnPathFromSearch(window.location.search), true));
    } catch {
      setFormMessage(GENERIC_LOGIN_ERROR);
    }
  });

  async function handleForgotPassword() {
    clearErrors('email');
    setFormMessage(null);
    setResetMessage(null);
    const emailResult = LoginFormSchema.shape.email.safeParse(getValues('email'));
    if (!emailResult.success) {
      setError('email', {
        message: emailResult.error.issues[0]?.message ?? '请输入有效的企业邮箱。',
      });
      setFocus('email');
      return;
    }
    const csrf = readCookie('geo_csrf');
    if (!csrf) {
      setFormMessage('安全令牌尚未就绪，请刷新页面后重试。');
      return;
    }

    setIsResetting(true);
    try {
      await requestPasswordReset(emailResult.data, csrf);
      setResetMessage(GENERIC_RESET_MESSAGE);
    } catch {
      setResetMessage(GENERIC_RESET_MESSAGE);
    } finally {
      setIsResetting(false);
    }
  }

  return (
    <form className="mt-8" noValidate onSubmit={submit}>
      <input {...register('csrf')} type="hidden" />

      {sessionMessage ? (
        <p
          className="mb-5 rounded-control bg-brand-50 px-3 py-2 text-sm text-brand-700"
          role="status"
        >
          {sessionMessage}
        </p>
      ) : null}

      <div>
        <label className="text-sm font-medium text-ink-700" htmlFor="login-email">
          企业邮箱
        </label>
        <input
          {...emailRegistration}
          aria-describedby={errors.email ? 'login-email-error' : undefined}
          aria-invalid={Boolean(errors.email)}
          autoComplete="email"
          className="mt-2 block h-12 w-full rounded-control border border-line bg-white px-3.5 text-base text-ink-950 transition placeholder:text-ink-500 hover:border-ink-500 focus:border-brand-500 focus:outline-none"
          id="login-email"
          inputMode="email"
          onChange={(event) => {
            void emailRegistration.onChange(event);
            setResetMessage(null);
          }}
          placeholder="name@company.com"
          type="email"
        />
        {errors.email?.message ? (
          <p className="mt-2 text-sm text-red-700" id="login-email-error">
            {errors.email.message}
          </p>
        ) : null}
      </div>

      <div className="mt-5">
        <div className="flex items-center justify-between gap-4">
          <label className="text-sm font-medium text-ink-700" htmlFor="login-password">
            密码
          </label>
          <button
            className="text-sm font-medium text-brand-700 hover:text-brand-600 disabled:cursor-wait disabled:opacity-60"
            disabled={isResetting || isSubmitting}
            onClick={() => void handleForgotPassword()}
            type="button"
          >
            {isResetting ? '正在发送…' : '忘记密码？'}
          </button>
        </div>
        <input
          {...register('password')}
          aria-describedby={errors.password ? 'login-password-error' : undefined}
          aria-invalid={Boolean(errors.password)}
          autoComplete="current-password"
          className="mt-2 block h-12 w-full rounded-control border border-line bg-white px-3.5 text-base text-ink-950 transition placeholder:text-ink-500 hover:border-ink-500 focus:border-brand-500 focus:outline-none"
          id="login-password"
          placeholder="请输入密码"
          type="password"
        />
        {errors.password?.message ? (
          <p className="mt-2 text-sm text-red-700" id="login-password-error">
            {errors.password.message}
          </p>
        ) : null}
      </div>

      <label className="mt-5 flex w-fit cursor-pointer items-center gap-2 text-sm text-ink-700">
        <input
          {...register('remember_me')}
          className="size-4 rounded border-line text-brand-600 focus:ring-brand-500"
          type="checkbox"
        />
        30 天内保持登录
      </label>

      <div aria-live="polite" className="mt-5 min-h-6">
        {formMessage ? (
          <p className="rounded-control bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
            {formMessage}
          </p>
        ) : null}
        {resetMessage ? (
          <p className="rounded-control bg-brand-50 px-3 py-2 text-sm text-brand-700" role="status">
            {resetMessage}
          </p>
        ) : null}
      </div>

      <button
        className="mt-3 flex h-12 w-full items-center justify-center rounded-control bg-brand-600 px-4 text-base font-semibold text-white transition hover:bg-brand-700 disabled:cursor-wait disabled:bg-brand-500"
        disabled={isSubmitting || isResetting}
        type="submit"
      >
        {isSubmitting ? '正在登录…' : '登录'}
      </button>

      <p className="mt-6 text-center text-xs leading-5 text-ink-500">
        登录即表示你同意遵守所在企业的内容安全与数据使用规范。
      </p>
    </form>
  );
}

function readCookie(name: string): string {
  if (typeof document === 'undefined') return '';
  const prefix = `${encodeURIComponent(name)}=`;
  const cookie = document.cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : '';
}
