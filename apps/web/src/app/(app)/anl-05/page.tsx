import type { Metadata } from 'next';

import { WentianConnector } from '../../../features/anl-05/wentian-connector';

export const metadata: Metadata = { title: '问天信源探测' };

export default function WentianConnectorPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header>
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">数据分析</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">问天信源探测</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-ink-500">
          把当前 GEO
          项目与独立部署的问天系统连接起来，同步测试问题，并进入问天查看消费端观察实验和信源分析。
        </p>
      </header>
      <WentianConnector />
    </main>
  );
}
