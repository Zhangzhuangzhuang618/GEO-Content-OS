import { expect, test } from '@playwright/test';

test('serves a nonce-bound CSP and hardened browser headers without CSP violations', async ({
  page,
}) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.text().toLowerCase().includes('content security policy')) {
      violations.push(message.text());
    }
  });

  const response = await page.goto('/');
  await page.waitForLoadState('networkidle');
  const csp = response?.headers()['content-security-policy'];
  const nonce = csp?.match(/'nonce-([^']+)'/u)?.[1];
  const scriptNonces = await page
    .locator('script')
    .evaluateAll((scripts) =>
      scripts.map((script) => (script as HTMLScriptElement).nonce).filter(Boolean),
    );

  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain("'unsafe-inline'");
  expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  if (!nonce) throw new Error('CSP nonce was not present');
  expect(scriptNonces.length).toBeGreaterThan(0);
  expect(new Set(scriptNonces)).toEqual(new Set([nonce]));
  expect(response?.headers()['x-content-type-options']).toBe('nosniff');
  expect(response?.headers()['x-frame-options']).toBe('DENY');
  expect(response?.headers()['cache-control']).toBe('no-store');
  expect(violations).toEqual([]);
});
