import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import './globals.css';
import { ApplicationProviders } from './providers';

// Nonce-based CSP requires request-time rendering so Next can attach the nonce to framework scripts.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: {
    default: 'GEO Content OS',
    template: '%s | GEO Content OS',
  },
  description: '企业级 GEO 多平台内容生产系统',
  applicationName: 'GEO Content OS',
};

export const viewport: Viewport = {
  colorScheme: 'light',
  themeColor: '#f4f7fb',
};

export interface RootLayoutProps {
  readonly children: ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="zh-CN">
      <body>
        <a
          className="sr-only fixed left-4 top-4 z-50 rounded-control bg-white px-4 py-2 text-sm font-semibold text-brand-700 shadow-panel focus:not-sr-only"
          href="#main-content"
        >
          跳到主要内容
        </a>
        <ApplicationProviders>{children}</ApplicationProviders>
      </body>
    </html>
  );
}
