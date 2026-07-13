export default function Loading() {
  return (
    <main
      aria-busy="true"
      aria-label="正在加载"
      className="mx-auto flex min-h-screen max-w-6xl items-center px-6 py-16"
      id="main-content"
    >
      <div className="h-80 w-full animate-pulse rounded-3xl border border-line bg-white shadow-panel" />
    </main>
  );
}
