import type { Metadata } from 'next';
import { SourceUploadForm } from '../../../features/know-02/source-upload-form';
export const metadata: Metadata = { title: '上传资料' };
export default function SourceUploadPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-4xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header>
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">知识库</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">上传资料</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          可提交单个文件、单个 URL，或从 XLSX/CSV 表格批量导入
          URL；每份资料都会独立校验并创建解析任务。
        </p>
      </header>
      <SourceUploadForm />
    </main>
  );
}
