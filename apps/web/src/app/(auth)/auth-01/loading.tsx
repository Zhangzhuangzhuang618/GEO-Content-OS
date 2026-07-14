export default function LoginLoading() {
  return (
    <main
      aria-busy="true"
      aria-label="正在加载登录页面"
      className="mx-auto flex min-h-screen max-w-md items-center px-5 py-10"
      id="main-content"
    >
      <div className="w-full animate-pulse rounded-3xl border border-line bg-white p-8 shadow-panel">
        <div className="h-4 w-32 rounded bg-brand-100" />
        <div className="mt-6 h-9 w-48 rounded bg-slate-200" />
        <div className="mt-10 h-11 rounded bg-slate-100" />
        <div className="mt-5 h-11 rounded bg-slate-100" />
        <div className="mt-8 h-12 rounded bg-brand-100" />
      </div>
    </main>
  );
}
