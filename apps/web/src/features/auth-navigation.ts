const DEFAULT_RETURN_PATH = '/dash-01';

export function returnPathFromSearch(search: string): string {
  return safeInternalPath(new URLSearchParams(search).get('return_to'));
}

export function tenantEntryPath(returnPath: string, automatic = true): string {
  const query = new URLSearchParams({ return_to: safeInternalPath(returnPath) });
  if (automatic) query.set('auto', '1');
  return `/auth-02?${query}`;
}

export function expiredSessionLoginPath(returnPath: string): string {
  const query = new URLSearchParams({
    reason: 'session_expired',
    return_to: safeInternalPath(returnPath),
  });
  return `/auth-01?${query}`;
}

export function currentApplicationPath(location: Location): string {
  return safeInternalPath(`${location.pathname}${location.search}`);
}

function safeInternalPath(value: string | null): string {
  if (!value?.startsWith('/') || value.startsWith('//')) return DEFAULT_RETURN_PATH;
  const parsed = new URL(value, 'http://geo-content-os.local');
  if (parsed.origin !== 'http://geo-content-os.local') return DEFAULT_RETURN_PATH;
  if (parsed.pathname === '/auth-01' || parsed.pathname === '/auth-02') {
    return DEFAULT_RETURN_PATH;
  }
  return `${parsed.pathname}${parsed.search}`;
}
