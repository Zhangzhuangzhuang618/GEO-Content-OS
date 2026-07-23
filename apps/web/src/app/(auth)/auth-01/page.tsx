import type { Metadata } from 'next';

import { LoginForm } from '../../../features/auth-01/login-form';

export const metadata: Metadata = {
  title: '登录',
};

export default function LoginPage() {
  return (
    <main
      className="mx-auto grid min-h-screen w-full max-w-7xl items-center gap-10 px-5 py-10 sm:px-8 lg:grid-cols-[1.05fr_0.95fr] lg:px-12"
      id="main-content"
    >
      <section className="hidden max-w-xl lg:block" aria-labelledby="product-heading">
        <p className="text-sm font-semibold tracking-[0.18em] text-brand-600 uppercase">
          GEO Content OS
        </p>
        <h1
          className="mt-5 text-5xl leading-[1.08] font-semibold tracking-tight text-ink-950"
          id="product-heading"
        >
          让每一份内容都可追溯、可审核、可交付
        </h1>
        <p className="mt-6 max-w-lg text-lg leading-8 text-ink-500">
          在企业工作空间内连接策略、资料、内容生产、质量审核与七平台交付。
        </p>
        <dl className="mt-10 grid grid-cols-3 gap-4" aria-label="系统能力">
          <div className="rounded-2xl border border-brand-100 bg-brand-50 p-4">
            <dt className="text-sm text-ink-500">平台</dt>
            <dd className="mt-2 text-2xl font-semibold text-brand-700">7</dd>
          </div>
          <div className="rounded-2xl border border-brand-100 bg-brand-50 p-4">
            <dt className="text-sm text-ink-500">智能创作能力</dt>
            <dd className="mt-2 text-2xl font-semibold text-brand-700">6</dd>
          </div>
          <div className="rounded-2xl border border-brand-100 bg-brand-50 p-4">
            <dt className="text-sm text-ink-500">事实链路</dt>
            <dd className="mt-2 text-2xl font-semibold text-brand-700">全程</dd>
          </div>
        </dl>
      </section>

      <section
        aria-labelledby="login-heading"
        className="mx-auto w-full max-w-md rounded-3xl border border-line bg-white p-6 shadow-panel sm:p-9"
      >
        <div className="lg:hidden">
          <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">
            GEO Content OS
          </p>
        </div>
        <h2
          className="mt-3 text-3xl font-semibold tracking-tight text-ink-950 lg:mt-0"
          id="login-heading"
        >
          登录工作空间
        </h2>
        <p className="mt-2 text-sm leading-6 text-ink-500">使用企业账号继续访问内容生产系统。</p>
        <LoginForm />
      </section>
    </main>
  );
}
