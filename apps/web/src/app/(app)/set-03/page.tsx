import type { Metadata } from 'next';
import { PlatformConfigManager } from '../../../features/set-03/platform-config-manager';

export const metadata: Metadata = { title: '平台规则与 Prompt' };

export default function PlatformConfigPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header className="mb-8">
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">平台配置</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">
          平台规则与 Prompt
        </h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          管理全局不可变版本。测试仅校验本地契约，不调用模型或真实发布平台。
        </p>
      </header>
      <PlatformConfigManager />
    </main>
  );
}
