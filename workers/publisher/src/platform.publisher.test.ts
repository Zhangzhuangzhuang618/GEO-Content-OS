import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { SevenPlatformPublisher } from './platform.publisher.js';
import type { PublishClaim } from './publisher.types.js';

const fixtureUrl = new URL(
  '../../../packages/adapters/platforms/official_site/render/fixtures/official-site.valid.input.json',
  import.meta.url,
);

describe('SevenPlatformPublisher', () => {
  it('removes content storage metadata before rendering an official-site export', async () => {
    const fixture = (await readJson(fixtureUrl)) as {
      readonly citations: PublishClaim['citations'];
      readonly content: Readonly<Record<string, unknown>>;
    };
    const claim = createClaim(
      {
        ...fixture.content,
        schema_version: 'content-writer-data@1',
      },
      fixture.citations,
    );

    const result = await new SevenPlatformPublisher().deliver(claim, null);

    expect(result.mode).toBe('export');
    if (result.mode !== 'export') return;
    expect(result.bundle).toMatchObject({
      platform_code: 'official_site',
      schema_version: 'official-site-export@1',
    });
  });

  it('rejects unsupported content storage schemas', async () => {
    const fixture = (await readJson(fixtureUrl)) as {
      readonly content: Readonly<Record<string, unknown>>;
    };
    const claim = createClaim({
      ...fixture.content,
      schema_version: 'content-writer-data@2',
    });

    expect(() => new SevenPlatformPublisher().deliver(claim, null)).toThrow(
      'CONTENT_SCHEMA_UNSUPPORTED',
    );
  });
});

function createClaim(
  content: Readonly<Record<string, unknown>>,
  citations: PublishClaim['citations'] = [],
): PublishClaim {
  return {
    accountStatus: 'active',
    accountTokenExpiresAt: null,
    attempt: 1,
    citations,
    content,
    contentVersionId: randomUUID(),
    credentialCiphertext: null,
    credentialKeyVersion: null,
    idempotencyKey: `official-site:${randomUUID()}`,
    jobId: randomUUID(),
    payloadHash: 'a'.repeat(64),
    platformCode: 'official_site',
    publishMode: 'export',
    tenantId: randomUUID(),
  };
}

async function readJson(url: URL): Promise<unknown> {
  return JSON.parse(await readFile(url, 'utf8')) as unknown;
}
