import type { Metadata } from 'next';
import { AiVisibilityLab } from '../../../features/anl-03/ai-visibility-lab';
import { VisibilityManager } from '../../../features/anl-03/visibility-manager';

export const metadata: Metadata = { title: 'AI 可见度' };
export default function VisibilityPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header>
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">数据分析</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">AI 可见度</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          用固定问题集体检品牌在 AI 回答中的提及、排名、推荐和竞品差距，再把缺口转成内容任务。
        </p>
      </header>
      <AiVisibilityLab />
      <details className="group mt-8 rounded-2xl border border-line bg-white p-5 shadow-panel">
        <summary className="cursor-pointer list-none text-sm font-semibold text-ink-700">
          人工观察与 CSV 补录 <span className="font-normal text-ink-500">（高级工具）</span>
        </summary>
        <p className="mt-2 text-sm text-ink-500">
          用于补录官网、百家号等发布平台的人工排名和截图证据，不参与上方 AI 体检分数。
        </p>
        <VisibilityManager />
      </details>
    </main>
  );
}
