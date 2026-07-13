const FOUNDATION_ITEMS = [
  '多租户 SaaS 隔离',
  '七平台内容工作流',
  '可追溯 RAG 与事实校验',
  'AI Skills 与 Adapter 分层',
] as const;

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-6xl items-center px-6 py-16" id="main-content">
      <section className="w-full overflow-hidden rounded-3xl border border-line bg-white shadow-panel">
        <div className="grid gap-10 p-8 sm:p-12 lg:grid-cols-[1.3fr_1fr] lg:p-16">
          <div>
            <p className="mb-4 text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">
              GEO Content OS
            </p>
            <h1 className="max-w-3xl text-4xl leading-tight font-semibold tracking-tight text-ink-950 sm:text-5xl">
              企业级多平台内容生产系统
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-7 text-ink-500 sm:text-lg">
              基础应用骨架已就绪。后续模块将按冻结任务依赖逐步接入身份、工作区、知识库、内容生产与平台发布能力。
            </p>
            <div className="mt-8 inline-flex items-center gap-2 rounded-full border border-brand-100 bg-brand-50 px-4 py-2 text-sm font-medium text-brand-700">
              <span aria-hidden="true" className="size-2 rounded-full bg-brand-500" />
              Foundation ready
            </div>
          </div>

          <div className="rounded-2xl border border-line bg-surface-subtle p-6">
            <h2 className="text-sm font-semibold text-ink-700">冻结能力边界</h2>
            <ul className="mt-5 space-y-4">
              {FOUNDATION_ITEMS.map((item) => (
                <li className="flex items-start gap-3 text-sm leading-6 text-ink-700" key={item}>
                  <span
                    aria-hidden="true"
                    className="mt-1.5 size-3 rounded-full border-4 border-brand-100 bg-brand-600"
                  />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </main>
  );
}
