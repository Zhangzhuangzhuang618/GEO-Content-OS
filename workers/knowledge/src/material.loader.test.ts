import { InMemoryStorageAdapter } from '@geo-content-os/adapter-storage';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { IngestSource, KnowledgeIngestData } from './ingest.types.js';
import { AdapterMaterialLoader } from './material.loader.js';

const BODY = new TextEncoder().encode('trusted knowledge source');
const HASH = createHash('sha256').update(BODY).digest('hex');
const SOURCE: IngestSource = {
  contentHash: HASH,
  effectiveFrom: null,
  effectiveTo: null,
  id: '53000000-0000-4000-8000-000000000040',
  language: 'zh-CN',
  mimeType: 'text/plain',
  metadata: {},
  sourceType: 'txt',
  status: 'processing',
  tenantId: '23000000-0000-4000-8000-000000000040',
  title: 'Trusted source',
  workspaceId: '33000000-0000-4000-8000-000000000040',
};
const DATA: KnowledgeIngestData = {
  contentHash: HASH,
  ingestJobId: '63000000-0000-4000-8000-000000000040',
  objectKey: 'tenant/workspace/source.txt',
  redirectChain: [],
  sourceDocumentId: SOURCE.id,
  workspaceId: SOURCE.workspaceId,
};

describe('adapter material loader', () => {
  it('loads a bounded storage object and verifies its bytes', async () => {
    const storage = new InMemoryStorageAdapter();
    await storage.putObject({
      body: BODY,
      contentHash: HASH,
      contentType: 'text/plain',
      key: DATA.objectKey!,
    });
    const loader = new AdapterMaterialLoader(storage, neverFetch());
    const loaded = await loader.load(SOURCE, DATA);
    expect(loaded).toMatchObject({ contentHash: HASH, mimeType: 'text/plain' });
    expect(loaded.body).toEqual(BODY);
  });

  it('rejects an object whose declared hash does not match its bytes', async () => {
    const storage = new InMemoryStorageAdapter();
    const changed = new TextEncoder().encode('changed storage bytes');
    await storage.putObject({
      body: changed,
      contentHash: createHash('sha256').update(changed).digest('hex'),
      contentType: 'text/plain',
      key: DATA.objectKey!,
    });
    await expect(
      new AdapterMaterialLoader(storage, neverFetch()).load(SOURCE, DATA),
    ).rejects.toMatchObject({
      code: 'SOURCE_HASH_MISMATCH',
      retryable: false,
    });
  });

  it('fails permanently when a registered web source changes', async () => {
    const source = { ...SOURCE, sourceType: 'url' as const };
    const changed = new TextEncoder().encode('changed source');
    const loader = new AdapterMaterialLoader(new InMemoryStorageAdapter(), {
      fetch: async () => ({
        body: Buffer.from(changed),
        contentHash: createHash('sha256').update(changed).digest('hex'),
        contentType: 'text/plain',
        finalUrl: 'https://example.com/source',
        redirectChain: [],
        statusCode: 200,
      }),
    });
    await expect(
      loader.load(source, {
        contentHash: DATA.contentHash,
        ingestJobId: DATA.ingestJobId,
        redirectChain: DATA.redirectChain,
        sourceDocumentId: DATA.sourceDocumentId,
        sourceUrl: 'https://example.com/source',
        workspaceId: DATA.workspaceId,
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_CONTENT_CHANGED', retryable: false });
  });

  it('loads the immutable registration snapshot for a URL without fetching it again', async () => {
    const storage = new InMemoryStorageAdapter();
    await storage.putObject({
      body: BODY,
      contentHash: HASH,
      contentType: 'text/plain',
      key: DATA.objectKey!,
    });
    const loaded = await new AdapterMaterialLoader(storage, neverFetch()).load(
      { ...SOURCE, sourceType: 'url' },
      { ...DATA, sourceUrl: 'https://example.com/source' },
    );
    expect(loaded).toMatchObject({
      contentHash: HASH,
      mimeType: 'text/plain',
      url: 'https://example.com/source',
    });
    expect(loaded.body).toEqual(BODY);
  });
});

function neverFetch() {
  return {
    fetch: async (): Promise<never> => {
      throw new Error('Web fetch must not run');
    },
  };
}
