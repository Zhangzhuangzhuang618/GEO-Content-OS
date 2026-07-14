export default function TenantSelectionLoading() {
  return (
    <main
      aria-busy="true"
      aria-label="正在加载企业列表"
      className="mx-auto min-h-screen w-full max-w-5xl px-5 py-16"
    >
      <div className="mx-auto h-4 w-36 animate-pulse rounded bg-brand-100" />
      <div className="mx-auto mt-5 h-10 w-64 animate-pulse rounded bg-line" />
      <div className="mx-auto mt-12 grid max-w-3xl gap-4 sm:grid-cols-2">
        {[0, 1, 2].map((item) => (
          <div className="h-40 animate-pulse rounded-2xl border border-line bg-white" key={item} />
        ))}
      </div>
    </main>
  );
}
