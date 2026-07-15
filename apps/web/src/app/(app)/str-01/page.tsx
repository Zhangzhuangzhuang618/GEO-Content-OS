import type { Metadata } from 'next';
import { BrandProfileList } from '../../../features/str-01/brand-profile-list';
export const metadata: Metadata = { title: '品牌策略列表' };
export default function BrandProfileListPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header className="mb-8">
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">策略中心</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">品牌策略</h1>
        <p className="mt-2 text-sm text-ink-500">查看不可变策略版本，并按权限发布或退役。</p>
      </header>
      <BrandProfileList />
    </main>
  );
}
