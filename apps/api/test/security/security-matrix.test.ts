import {
  SafeWebFetchAdapter,
  WebFetchBlockedError,
  type WebFetchDependencies,
} from '@geo-content-os/adapter-web-fetch';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
  generateSecureToken,
  redactSensitiveData,
} from '@geo-content-os/security';
import {
  CredentialEnvelopeService,
  LocalCredentialKms,
} from '@geo-content-os/security/credentials';
import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import fastifyCookie from '@fastify/cookie';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerCsrfHook } from '../../src/common/security/index.js';
import { migrateDatabase } from '../../src/database/migrate.js';
import { OutboxWriter } from '../../src/modules/outbox/index.js';
import {
  TenantLifecycleService,
  TenantLifecycleStateError,
  TenantLifecycleValidationError,
  type TenantLifecycleScope,
} from '../../src/modules/tenant-lifecycle/index.js';

interface SecurityCase {
  readonly category: SecurityCategory;
  readonly dns_answers?: readonly string[];
  readonly expected: string;
  readonly id: string;
  readonly input?: string;
  readonly method?: string;
  readonly vector: string;
}

type SecurityCategory =
  'credential_leakage' | 'csrf' | 'sql_injection' | 'ssrf' | 'tenant_isolation' | 'xss';

const MATRIX = loadMatrix();
const OWNER_A = '1e000000-0000-4000-8000-000000000138';
const OWNER_B = '1e000000-0000-4000-8000-000000000238';
const TENANT_A = '2e000000-0000-4000-8000-000000000138';
const TENANT_B = '2e000000-0000-4000-8000-000000000238';
const WORKSPACE_A = '3e000000-0000-4000-8000-000000000138';
const WORKSPACE_B = '3e000000-0000-4000-8000-000000000238';

describe('T138 security matrix integrity', () => {
  it('contains stable, unique cases for every required category', () => {
    const categories = new Set(MATRIX.map((entry) => entry.category));
    const ids = MATRIX.map((entry) => entry.id);

    expect(categories).toEqual(
      new Set<SecurityCategory>([
        'credential_leakage',
        'csrf',
        'sql_injection',
        'ssrf',
        'tenant_isolation',
        'xss',
      ]),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[A-Z]+-\d{3}$/u.test(id))).toBe(true);
  });
});

describe('tenant isolation and SQL injection', () => {
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 4 });
  }, 120_000);

  beforeEach(async () => {
    const database = requireClient(client);
    await database`TRUNCATE users, tenants CASCADE`;
    await seedTenants(database);
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('returns the generic missing-resource state for a valid foreign-tenant identifier', async () => {
    expect(caseById('TENANT-001').expected).toBe('not_found');
    const database = requireClient(client);
    const service = new TenantLifecycleService(database, new OutboxWriter(database));
    const job = await database.begin((transaction) =>
      service.requestExport(transaction, scope(TENANT_A, OWNER_A)),
    );

    await expect(service.getExport(scope(TENANT_B, OWNER_B), job.id)).rejects.toBeInstanceOf(
      TenantLifecycleStateError,
    );
  });

  it('rejects an injected resource identifier before SQL and preserves the table', async () => {
    const attack = caseById('INJECTION-001');
    const database = requireClient(client);
    const service = new TenantLifecycleService(database, new OutboxWriter(database));

    await expect(
      service.getExport(scope(TENANT_A, OWNER_A), requireInput(attack)),
    ).rejects.toBeInstanceOf(TenantLifecycleValidationError);
    expect(
      await database<{ tableName: string | null }[]>`
        SELECT to_regclass('public.tenant_export_jobs')::text AS "tableName"
      `,
    ).toEqual([{ tableName: 'tenant_export_jobs' }]);
  });
});

describe('SSRF attack corpus', () => {
  it('blocks cloud metadata and mixed public/private DNS without opening a socket', async () => {
    const direct = caseById('SSRF-001');
    const rebinding = caseById('SSRF-002');
    const request = vi.fn(async () => htmlResponse());
    const directAdapter = createWebFetchAdapter({ request });
    const rebindingAdapter = createWebFetchAdapter({
      lookup: async () =>
        (rebinding.dns_answers ?? []).map((address) => ({
          address,
          family: 4 as const,
        })),
      request,
    });

    await expect(directAdapter.fetch(requireInput(direct))).rejects.toBeInstanceOf(
      WebFetchBlockedError,
    );
    await expect(rebindingAdapter.fetch(requireInput(rebinding))).rejects.toBeInstanceOf(
      WebFetchBlockedError,
    );
    expect(request).not.toHaveBeenCalled();
  });
});

describe('CSRF browser/session confusion', () => {
  it('does not let a Bearer header bypass double-submit checks when a session cookie exists', async () => {
    const server = Fastify({ genReqId: () => 't138-security-request' });
    await server.register(fastifyCookie);
    registerCsrfHook(server);
    server.post('/write', async () => ({ ok: true }));
    await server.ready();

    try {
      const token = generateSecureToken();
      const headers = {
        authorization: 'Bearer benign-security-canary',
        cookie: `${SESSION_COOKIE_NAME}=session-canary; ${CSRF_COOKIE_NAME}=${token}`,
      };
      const blocked = await server.inject({ headers, method: 'POST', url: '/write' });
      const allowed = await server.inject({
        headers: { ...headers, [CSRF_HEADER_NAME]: token },
        method: 'POST',
        url: '/write',
      });

      expect(caseById('CSRF-001').expected).toBe('blocked_without_double_submit');
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json()).toMatchObject({ error: { code: 'CSRF_INVALID' } });
      expect(caseById('CSRF-002').expected).toBe('allowed');
      expect(allowed.statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });
});

describe('credential leakage canary', () => {
  it('keeps plaintext out of ciphertext, generic failures, and structured logs', async () => {
    const canary = requireInput(caseById('CREDENTIAL-001'));
    const kms = new LocalCredentialKms('t138-v1', { 't138-v1': randomBytes(32) });
    const service = new CredentialEnvelopeService(kms);
    const stored = await service.encrypt(JSON.stringify({ access_token: canary }));
    const replacement = stored.credentialCiphertext.endsWith('A') ? 'B' : 'A';
    const tampered = {
      ...stored,
      credentialCiphertext: `${stored.credentialCiphertext.slice(0, -1)}${replacement}`,
    };

    try {
      expect(JSON.stringify(stored)).not.toContain(canary);
      await expect(service.decrypt(tampered)).rejects.toMatchObject({
        message: 'Credential decryption failed',
      });
      expect(
        JSON.stringify(redactSensitiveData({ ...stored, access_token: canary })),
      ).not.toContain(canary);
    } finally {
      kms.destroy();
    }
  });
});

function loadMatrix(): readonly SecurityCase[] {
  const path = new URL(
    '../../../../packages/testkit/security/security-matrix.json',
    import.meta.url,
  );
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    readonly cases?: readonly SecurityCase[];
    readonly schema_version?: string;
  };
  if (parsed.schema_version !== '1.0' || !Array.isArray(parsed.cases)) {
    throw new Error('T138 security matrix is invalid');
  }
  return parsed.cases;
}

function caseById(id: string): SecurityCase {
  const securityCase = MATRIX.find((entry) => entry.id === id);
  if (!securityCase) throw new Error(`Missing security case ${id}`);
  return securityCase;
}

function requireInput(securityCase: SecurityCase): string {
  if (!securityCase.input) throw new Error(`Security case ${securityCase.id} has no input`);
  return securityCase.input;
}

function scope(tenantId: string, userId: string): TenantLifecycleScope {
  return { requestId: 't138-security-request', tenantId, userId };
}

function createWebFetchAdapter(dependencies: WebFetchDependencies): SafeWebFetchAdapter {
  return new SafeWebFetchAdapter(
    {
      allowedHosts: [],
      allowedPorts: [80, 443],
      deniedHosts: [],
      maxBytes: 1_024,
      maxRedirects: 2,
      timeoutMs: 2_000,
      userAgent: 'GEO-Content-OS-T138/1.0',
    },
    {
      lookup: async () => [{ address: '1.1.1.1', family: 4 }],
      ...dependencies,
    },
  );
}

function htmlResponse() {
  return Promise.resolve({
    body: Buffer.from('<html>safe</html>'),
    headers: { 'content-type': 'text/html' },
    statusCode: 200,
  });
}

async function seedTenants(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id,email,display_name,status) VALUES
      (${OWNER_A},'t138-owner-a@example.com','T138 Owner A','active'),
      (${OWNER_B},'t138-owner-b@example.com','T138 Owner B','active')
  `;
  await database`
    INSERT INTO tenants (id,name,slug,status) VALUES
      (${TENANT_A},'T138 Tenant A','t138-tenant-a','active'),
      (${TENANT_B},'T138 Tenant B','t138-tenant-b','active')
  `;
  await database`
    INSERT INTO memberships (tenant_id,user_id,role_code,status) VALUES
      (${TENANT_A},${OWNER_A},'tenant_owner','active'),
      (${TENANT_B},${OWNER_B},'tenant_owner','active')
  `;
  await database`
    INSERT INTO workspaces (id,tenant_id,name,slug,timezone,status) VALUES
      (${WORKSPACE_A},${TENANT_A},'T138 Workspace A','t138-workspace-a','UTC','active'),
      (${WORKSPACE_B},${TENANT_B},'T138 Workspace B','t138-workspace-b','UTC','active')
  `;
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('T138 PostgreSQL client is not initialized');
  return client;
}
