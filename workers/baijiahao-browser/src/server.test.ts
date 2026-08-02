import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGatewayServer } from './server.js';
import type { BaijiahaoBrowserService } from './service.js';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000145';
const TOKEN = 'x'.repeat(32);

describe('Baijiahao browser gateway routes', () => {
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

  it('routes session login by path without requiring a delivery account header', async () => {
    const startLogin = vi.fn(async () => ({
      account_id: ACCOUNT_ID,
      status: 'qr_ready',
      version: 1,
    }));
    const service = fakeService({ startLogin });
    const baseUrl = await listen(service);

    const response = await fetch(`${baseUrl}/sessions/${ACCOUNT_ID}/login`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(startLogin).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  it('rejects unauthorized session requests before invoking the browser', async () => {
    const startLogin = vi.fn();
    const baseUrl = await listen(fakeService({ startLogin }));

    const response = await fetch(`${baseUrl}/sessions/${ACCOUNT_ID}/login`, { method: 'POST' });

    expect(response.status).toBe(401);
    expect(startLogin).not.toHaveBeenCalled();
  });

  it('passes the Adapter idempotency header into the frozen browser request', async () => {
    const publish = vi.fn(async () => ({
      external_id: 'remote-145',
      status: 'processing',
      url: null,
    }));
    const baseUrl = await listen(fakeService({ publish }));

    const response = await fetch(`${baseUrl}/publish`, {
      body: JSON.stringify({ content_version_id: ACCOUNT_ID }),
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': 'baijiahao:variant:version',
        'x-platform-account-id': ACCOUNT_ID,
      },
      method: 'POST',
    });

    expect(response.status).toBe(202);
    expect(publish).toHaveBeenCalledWith(ACCOUNT_ID, {
      content_version_id: ACCOUNT_ID,
      idempotency_key: 'baijiahao:variant:version',
    });
  });

  async function listen(service: BaijiahaoBrowserService): Promise<string> {
    const server = createGatewayServer(service, () => true);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }
});

function fakeService(overrides: Readonly<Record<string, unknown>>): BaijiahaoBrowserService {
  return {
    authenticate(value: string | undefined) {
      if (value !== `Bearer ${TOKEN}`) {
        throw Object.assign(new Error('Unauthorized'), { code: 'UNAUTHORIZED', statusCode: 401 });
      }
    },
    ...overrides,
  } as unknown as BaijiahaoBrowserService;
}
