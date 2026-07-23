import type { Metadata } from 'next';

import { QualityReportDetail } from '../../../features/qual-01/quality-report-detail';

export const metadata: Metadata = { title: '质量报告' };

export default function QualityReportPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header>
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">质量门禁</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">质量报告</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          核对门禁结论、问题、事实声明与证据，并定位修改或重新检查。
        </p>
      </header>
      <QualityReportDetail />
    </main>
  );
}
