import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl items-center px-6" id="main-content">
      <section className="w-full rounded-2xl border border-line bg-white p-8 text-center shadow-panel">
        <p className="text-sm font-semibold text-brand-600">404</p>
        <h1 className="mt-3 text-2xl font-semibold text-ink-950">页面不存在</h1>
        <p className="mt-3 text-sm leading-6 text-ink-500">该地址无效，或页面已经被移动。</p>
        <Link
          className="mt-7 inline-flex rounded-control bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700"
          href="/"
        >
          返回首页
        </Link>
      </section>
    </main>
  );
}
