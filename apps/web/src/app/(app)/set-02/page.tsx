import type { Metadata } from 'next';
import { WorkspaceSettingsEditor } from '../../../features/set-02/workspace-settings-editor';

export const metadata: Metadata = { title: '工作区设置' };

export default function WorkspaceSettingsPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-6xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header className="mb-8">
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">系统设置</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">工作区设置</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          管理工作区标识、时区、默认平台、审核门槛和月度预算。
        </p>
      </header>
      <WorkspaceSettingsEditor />
    </main>
  );
}
