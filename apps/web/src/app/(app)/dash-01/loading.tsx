export default function DashboardLoading() {
  return (
    <main
      aria-busy="true"
      aria-label="正在加载工作台"
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-12"
    >
      <div className="h-9 w-36 animate-pulse rounded bg-line" />
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((item) => (
          <div className="h-36 animate-pulse rounded-2xl border border-line bg-white" key={item} />
        ))}
      </div>
    </main>
  );
}
