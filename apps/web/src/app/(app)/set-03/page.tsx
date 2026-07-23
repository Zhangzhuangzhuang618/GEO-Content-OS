import type { Metadata } from 'next';
import { PlatformConfigManager } from '../../../features/set-03/platform-config-manager';

export const metadata: Metadata = { title: 'AI 生成与平台规则' };

export default function PlatformConfigPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header className="mb-8">
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">平台配置</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">
          AI 生成与平台规则
        </h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          管理 AI 生成指令和七个平台的内容规则。测试不会调用 AI 或真实发布平台。
        </p>
      </header>
      <PlatformConfigManager />
    </main>
  );
}
