export default function Loading() {
  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-5 py-8 sm:px-8 sm:py-12">
      <div className="h-4 w-20 animate-pulse rounded bg-line" />
      <div className="mt-4 h-9 w-52 animate-pulse rounded bg-line" />
      <div className="mt-8 h-[36rem] animate-pulse rounded-2xl bg-surface-subtle" />
    </main>
  );
}
