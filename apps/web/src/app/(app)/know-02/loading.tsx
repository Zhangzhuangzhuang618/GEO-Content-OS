export default function SourceUploadLoading() {
  return (
    <main
      aria-busy="true"
      aria-label="正在加载上传表单"
      className="mx-auto min-h-screen w-full max-w-4xl px-5 py-12"
    >
      <div className="h-9 w-40 animate-pulse rounded bg-line" />
      <div className="mt-8 h-[32rem] animate-pulse rounded-2xl bg-white" />
    </main>
  );
}
