export default function BrandEditorLoading() {
  return (
    <main
      aria-busy="true"
      aria-label="正在加载品牌策略"
      className="mx-auto min-h-screen w-full max-w-5xl px-5 py-12"
    >
      <div className="h-9 w-56 animate-pulse rounded bg-line" />
      <div className="mt-8 h-[34rem] animate-pulse rounded-2xl border border-line bg-white" />
    </main>
  );
}
