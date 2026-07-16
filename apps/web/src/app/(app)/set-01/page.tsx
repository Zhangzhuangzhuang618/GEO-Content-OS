import type { Metadata } from 'next';
import { MemberAdministration } from '../../../features/set-01/member-administration';

export const metadata: Metadata = { title: '成员与邀请' };

export default function MemberAdministrationPage() {
  return (
    <main
      className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12"
      id="main-content"
    >
      <header className="mb-8">
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">系统设置</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">成员与邀请</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          管理租户成员角色、工作区范围、状态和邀请到期时间。
        </p>
      </header>
      <MemberAdministration />
    </main>
  );
}
