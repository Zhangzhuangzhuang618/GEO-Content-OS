import { describe, expect, it } from 'vitest';

import { validateKnowledgeIngestEvent } from './ingest.event.js';

const TENANT = '23000000-0000-4000-8000-000000000040';
const SOURCE = '53000000-0000-4000-8000-000000000040';
const JOB = '63000000-0000-4000-8000-000000000040';
const EVENT = '73000000-0000-4000-8000-000000000040';
const WORKSPACE = '33000000-0000-4000-8000-000000000040';

describe('knowledge ingest event validation', () => {
  it('normalizes a strict file ingest event', () => {
    expect(validateKnowledgeIngestEvent(event())).toMatchObject({
      aggregateId: SOURCE,
      data: {
        contentHash: 'a'.repeat(64),
        ingestJobId: JOB,
        objectKey: 'tenant/workspace/source.txt',
        redirectChain: [],
        sourceDocumentId: SOURCE,
        workspaceId: WORKSPACE,
      },
      eventId: EVENT,
      tenantId: TENANT,
    });
  });

  it.each(['http://example.com/source', 'https://example.com/source'])(
    'accepts a credential-free HTTP(S) URL: %s',
    (sourceUrl) => {
      const base = event();
      const { object_key: _objectKey, ...filelessData } = base.data;
      expect(
        validateKnowledgeIngestEvent({
          ...base,
          data: {
            ...filelessData,
            source_url: sourceUrl,
          },
        }),
      ).toMatchObject({ data: { sourceUrl } });
    },
  );

  it('accepts a URL snapshot with its canonical URL and redirect provenance', () => {
    const base = event();
    expect(
      validateKnowledgeIngestEvent({
        ...base,
        data: {
          ...base.data,
          redirect_chain: ['https://example.com/original'],
          source_url: 'https://example.com/canonical',
        },
      }),
    ).toMatchObject({
      data: {
        objectKey: 'tenant/workspace/source.txt',
        redirectChain: ['https://example.com/original'],
        sourceUrl: 'https://example.com/canonical',
      },
    });
  });

  it.each([
    { data: { object_key: undefined, source_url: 'ftp://example.com/source' } },
    { data: { object_key: undefined, source_url: 'https://user@example.com/source' } },
    { data: { unknown: true } },
    { aggregate: { id: JOB, type: 'source_document' } },
  ])('rejects an ambiguous or forged event %#', (override) => {
    const base = event();
    const candidate = {
      ...base,
      ...override,
      data: { ...base.data, ...(override.data ?? {}) },
    };
    expect(() => validateKnowledgeIngestEvent(candidate)).toThrow(/event is invalid/u);
  });
});

function event() {
  return {
    aggregate: { id: SOURCE, type: 'source_document' },
    data: {
      content_hash: 'a'.repeat(64),
      ingest_job_id: JOB,
      object_key: 'tenant/workspace/source.txt',
      source_document_id: SOURCE,
      workspace_id: WORKSPACE,
    },
    event_id: EVENT,
    event_type: 'knowledge.source.ingest_requested.v1',
    occurred_at: '2026-07-14T00:00:00.000Z',
    tenant: { id: TENANT },
  } as const;
}
