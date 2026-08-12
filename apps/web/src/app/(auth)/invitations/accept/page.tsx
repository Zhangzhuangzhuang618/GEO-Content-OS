import type { Metadata } from 'next';

import { InvitationAcceptForm } from '../../../../features/invitation-accept/invitation-accept-form';

export const metadata: Metadata = {
  title: '接受企业邀请',
};

export default function InvitationAcceptPage() {
  return (
    <main
      className="mx-auto flex min-h-screen w-full max-w-5xl items-center px-5 py-10 sm:px-8"
      id="main-content"
    >
      <section className="mx-auto w-full max-w-lg rounded-3xl border border-line bg-white p-6 shadow-panel sm:p-9">
        <p className="text-sm font-semibold tracking-[0.16em] text-brand-600 uppercase">
          GEO Content OS
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-950">接受企业邀请</h1>
        <p className="mt-2 text-sm leading-6 text-ink-500">
          完成账号信息后，你将以企业所有者或受邀角色进入对应企业。
        </p>
        <InvitationAcceptForm />
      </section>
    </main>
  );
}
