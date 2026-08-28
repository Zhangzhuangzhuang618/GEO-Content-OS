import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGatewayServer } from './server.js';
import type { DouyinBrowserService } from './service.js';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000158';
const TOKEN = 'x'.repeat(32);

describe('Douyin browser gateway routes', () => {
  const servers: ReturnType<typeof createGatewayServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map(
          (server) =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        ),
    );
  });

  it('starts QR login without requiring a delivery account header', async () => {
    const startLogin = vi.fn(async () => ({
      account_id: ACCOUNT_ID,
      status: 'qr_ready',
      version: 1,
    }));
    const baseUrl = await listen(fakeService({ startLogin }));
    const response = await fetch(`${baseUrl}/sessions/${ACCOUNT_ID}/login`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      method: 'POST',
    });
    expect(response.status).toBe(200);
    expect(startLogin).toHaveBeenCalledWith(ACCOUNT_ID, { method: 'qr' });
  });

  it('forwards an explicitly submitted SMS code without returning it in the response', async () => {
    const startLogin = vi.fn(async () => ({
      account_id: ACCOUNT_ID,
      authenticated_at: '2026-08-28T08:00:00.000Z',
      last_verified_at: '2026-08-28T08:00:00.000Z',
      qr_expires_at: null,
      status: 'authenticated',
      version: 2,
    }));
    const baseUrl = await listen(fakeService({ startLogin }));
    const response = await fetch(`${baseUrl}/sessions/${ACCOUNT_ID}/login`, {
      body: JSON.stringify({ method: 'verification_sms_verify', sms_code: '654321' }),
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store, private');
    expect(startLogin).toHaveBeenCalledWith(ACCOUNT_ID, {
      method: 'verification_sms_verify',
      sms_code: '654321',
    });
    expect(await response.text()).not.toContain('654321');
  });

  it('rejects extra credential fields in secondary verification requests', async () => {
    const startLogin = vi.fn();
    const baseUrl = await listen(fakeService({ startLogin }));
    const response = await fetch(`${baseUrl}/sessions/${ACCOUNT_ID}/login`, {
      body: JSON.stringify({
        method: 'verification_sms_verify',
        password: 'must-not-be-accepted',
        sms_code: '654321',
      }),
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });

    expect(response.status).toBe(400);
    expect(startLogin).not.toHaveBeenCalled();
  });

  it('passes the idempotency key into the frozen publish request', async () => {
    const publish = vi.fn(async () => ({
      external_id: 'remote-158',
      status: 'processing',
      url: null,
    }));
    const baseUrl = await listen(fakeService({ publish }));
    const response = await fetch(`${baseUrl}/publish`, {
      body: JSON.stringify({ content_version_id: ACCOUNT_ID }),
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': 'douyin:variant:version',
        'x-platform-account-id': ACCOUNT_ID,
      },
      method: 'POST',
    });
    expect(response.status).toBe(202);
    expect(publish).toHaveBeenCalledWith(ACCOUNT_ID, {
      content_version_id: ACCOUNT_ID,
      idempotency_key: 'douyin:variant:version',
    });
  });

  it('rejects unauthenticated gateway calls', async () => {
    const publish = vi.fn();
    const baseUrl = await listen(fakeService({ publish }));
    const response = await fetch(`${baseUrl}/publish`, { method: 'POST' });
    expect(response.status).toBe(401);
    expect(publish).not.toHaveBeenCalled();
  });

  async function listen(service: DouyinBrowserService): Promise<string> {
    const server = createGatewayServer(service, () => true);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
});

function fakeService(overrides: Readonly<Record<string, unknown>>): DouyinBrowserService {
  return {
    authenticate(value: string | undefined) {
      if (value !== `Bearer ${TOKEN}`) {
        throw Object.assign(new Error('Unauthorized'), { code: 'UNAUTHORIZED', statusCode: 401 });
      }
    },
    ...overrides,
  } as unknown as DouyinBrowserService;
}
