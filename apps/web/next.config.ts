import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  async rewrites() {
    const apiOrigin = internalApiOrigin();
    return [
      {
        destination: `${apiOrigin}/api/:path*`,
        source: '/api/:path*',
      },
    ];
  },
};

export default nextConfig;

function internalApiOrigin(): string {
  const configured = process.env['API_INTERNAL_ORIGIN']?.trim() || 'http://127.0.0.1:3001';
  const url = new URL(configured);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.origin !== configured.replace(/\/$/u, '')
  ) {
    throw new Error('API_INTERNAL_ORIGIN must be an HTTP(S) origin without a path');
  }
  return url.origin;
}
