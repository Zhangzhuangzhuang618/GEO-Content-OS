import type postgres from 'postgres';
import { describe, expect, it } from 'vitest';

import { insertGeneratedVersion, requiresAutomatedQuality } from './generation.store.js';
import type { GeneratedContent, ValidatedGenerationEvent } from './generation.types.js';

const EXISTING_VERSION_ID = '80000000-0000-4000-8000-000000000053';

describe('generated content version persistence', () => {
  it('reuses an immutable version when generated content is unchanged', async () => {
    const queries: string[] = [];
    const transaction = (async (strings: TemplateStringsArray) => {
      const query = strings.join('?');
      queries.push(query);
      if (query.includes('SELECT COALESCE(max(version_no)')) return [{ versionNo: 2 }];
      if (query.includes('INSERT INTO content_versions')) return [];
      if (query.includes('SELECT id FROM content_versions')) return [{ id: EXISTING_VERSION_ID }];
      throw new Error(`Unexpected SQL after version reuse: ${query}`);
    }) as unknown as postgres.TransactionSql;

    await expect(
      insertGeneratedVersion(transaction, event(), null, event().data.masterRunId, content()),
    ).resolves.toBe(EXISTING_VERSION_ID);

    expect(queries).toHaveLength(3);
    expect(queries[1]).toContain('ON CONFLICT DO NOTHING');
    expect(queries[2]).toContain('content_hash =');
    expect(queries.some((query) => query.includes('INSERT INTO content_blocks'))).toBe(false);
  });
});

describe('automatic quality handoff', () => {
  it('includes Douyin image-note variants in the automatic quality pipeline', () => {
    expect(requiresAutomatedQuality('douyin')).toBe(true);
    expect(requiresAutomatedQuality('sohu')).toBe(true);
    expect(requiresAutomatedQuality('lieju')).toBe(true);
    expect(requiresAutomatedQuality('zhihu')).toBe(false);
  });
});

function content(): GeneratedContent {
  return Object.freeze({
    blocks: Object.freeze([
      Object.freeze({ block_key: 'intro', block_type: 'paragraph', text: '正文' }),
    ]),
    citation_map: Object.freeze([]),
    cta: null,
    hashtags: Object.freeze([]),
    platform_code: 'master',
    platform_meta: Object.freeze({}),
    schema_version: 'content-writer-data@1',
    summary: '摘要',
    title: '标题',
  });
}

function event(): ValidatedGenerationEvent {
  return Object.freeze({
    data: Object.freeze({
      actorUserId: '10000000-0000-4000-8000-000000000053',
      inputHash: 'a'.repeat(64),
      masterRunId: '80000000-0000-4000-8000-000000000054',
      modelKey: 'deepseek-v4-flash',
      modelPolicy: 'balanced',
      packageId: '60000000-0000-4000-8000-000000000053',
      projectId: '40000000-0000-4000-8000-000000000053',
      promptVersionId: '90000000-0000-4000-8000-000000000053',
      requestId: 'generation-version-reuse-53',
      skillVersion: '1.0.0',
      variantRuns: Object.freeze([]),
      workspaceId: '30000000-0000-4000-8000-000000000053',
      writerInput: Object.freeze({}),
    }),
    eventId: 'a0000000-0000-4000-8000-000000000053',
    occurredAt: '2026-08-06T00:00:00.000Z',
    tenantId: '20000000-0000-4000-8000-000000000053',
  });
}
