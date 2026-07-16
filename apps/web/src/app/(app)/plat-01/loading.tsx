export default function PlatformTenantLoading() {
  return (
    <main
      aria-busy="true"
      aria-label="正在加载平台租户"
      className="mx-auto min-h-screen w-full max-w-7xl animate-pulse px-5 py-8 sm:px-8 sm:py-12"
    >
      <div className="h-9 w-64 rounded bg-surface-subtle" />
      <div className="mt-8 h-[34rem] rounded-2xl bg-surface-subtle" />
    </main>
  );
}
