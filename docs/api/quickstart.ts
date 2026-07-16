import { GeoContentOsClient } from '@geo-content-os/sdk';

const client = new GeoContentOsClient({ baseUrl: 'http://localhost:3001/api/v1' });

const workspaces = await client.request('workspaces_list', {
  query: { limit: 20, status: 'active' },
});

const tenant = await client.request('tenant_update', {
  body: { name: '示例租户', timezone: 'Asia/Shanghai' },
  headers: {
    'Idempotency-Key': crypto.randomUUID(),
    'If-Match': '"1"',
  },
});

console.log({ tenant, workspaces });
