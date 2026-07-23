export default function SourceListLoading() {
  return (
    <main
      aria-busy="true"
      aria-label="正在加载资料列表"
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-12"
    >
      <div className="h-9 w-40 animate-pulse rounded bg-line" />
      <div className="mt-8 h-20 animate-pulse rounded-2xl bg-white" />
      <div className="mt-5 h-80 animate-pulse rounded-2xl bg-white" />
    </main>
  );
}
