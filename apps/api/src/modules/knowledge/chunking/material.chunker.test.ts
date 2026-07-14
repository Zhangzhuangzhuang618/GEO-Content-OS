import { createHash } from 'node:crypto';

import type { ParsedMaterialDocument } from '@geo-content-os/parsers';
import { describe, expect, it } from 'vitest';

import { countChunkTokens, MaterialChunker } from './material.chunker.js';

describe('MaterialChunker', () => {
  it('creates deterministic 500-900 token chunks with exactly 80 overlapping tokens', () => {
    const text = words('token', 1_300);
    const document = parsedDocument([{ headings: ['Guide'], text }]);
    const chunker = new MaterialChunker();

    const first = chunker.chunk(document);
    const second = chunker.chunk(document);

    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
    expect(first.map((chunk) => chunk.tokenCount)).toEqual([700, 680]);
    for (const chunk of first) {
      expect(chunk.tokenCount).toBeGreaterThanOrEqual(500);
      expect(chunk.tokenCount).toBeLessThanOrEqual(900);
      expect(countChunkTokens(chunk.text)).toBe(chunk.tokenCount);
      expect(document.text.slice(chunk.metadata.char_start, chunk.metadata.char_end)).toBe(
        chunk.text,
      );
      expect(chunk.textHash).toBe(createHash('sha256').update(chunk.text).digest('hex'));
    }
    const firstTokens = first[0]!.text.split(' ');
    const secondTokens = first[1]!.text.split(' ');
    expect(firstTokens.slice(-80)).toEqual(secondTokens.slice(0, 80));
  });

  it('does not cross PDF page boundaries even when a page is below the minimum size', () => {
    const document = parsedDocument(
      [
        { headings: ['Page one'], page: 1, text: words('one', 300) },
        { headings: ['Page two'], page: 2, text: words('two', 300) },
      ],
      'pdf',
    );

    const chunks = new MaterialChunker().chunk(document);

    expect(chunks).toHaveLength(2);
    expect(chunks.map((chunk) => chunk.tokenCount)).toEqual([300, 300]);
    expect(chunks.map((chunk) => chunk.metadata.page)).toEqual([1, 2]);
    expect(chunks[0]?.text).not.toContain('two0000');
    expect(chunks[1]?.text).not.toContain('one0000');
  });

  it('combines adjacent URL units and keeps their common heading path and exact locator', () => {
    const url = 'https://example.com/guide';
    const document = parsedDocument(
      [
        { headings: ['Guide', 'A'], text: words('alpha', 300), url },
        { headings: ['Guide', 'B'], text: words('beta', 300), url },
      ],
      'url',
    );

    const chunks = new MaterialChunker().chunk(document);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      chunkNo: 0,
      chunkerVersion: 'chunker/1.0.0',
      metadata: {
        char_end: document.text.length,
        char_start: 0,
        headings: ['Guide'],
        schema_version: 'chunk-metadata@1',
        url,
      },
      tokenCount: 600,
    });
  });

  it('keeps different URL locators in separate chunks and uses UTF-16 character ranges', () => {
    const document = parsedDocument(
      [
        { headings: [], text: `😀 ${words('first', 40)}`, url: 'https://example.com/one' },
        { headings: [], text: words('second', 40), url: 'https://example.com/two' },
      ],
      'url',
    );

    const chunks = new MaterialChunker().chunk(document);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.metadata.url).toBe('https://example.com/one');
    expect(chunks[1]?.metadata.url).toBe('https://example.com/two');
    expect(chunks[0]?.metadata.char_start).toBe(0);
    expect(document.text.slice(chunks[0]?.metadata.char_start, chunks[0]?.metadata.char_end)).toBe(
      chunks[0]?.text,
    );
  });

  it('counts Han characters as stable individual tokens', () => {
    expect(countChunkTokens('企业级 GEO 内容生产')).toBe(8);
    const chunks = new MaterialChunker().chunk(
      parsedDocument([{ headings: [], text: '企'.repeat(1_000) }]),
    );
    expect(chunks.map((chunk) => chunk.tokenCount)).toEqual([580, 500]);
    expect(chunks[0]?.text.slice(-80)).toBe(chunks[1]?.text.slice(0, 80));
  });

  it('rejects invalid parser provenance and invalid policies', () => {
    const document = parsedDocument([{ headings: [], text: 'usable text' }]);
    const invalid: ParsedMaterialDocument = {
      ...document,
      units: [
        {
          ...document.units[0]!,
          text_hash: '0'.repeat(64),
        },
      ],
    };

    expect(() => new MaterialChunker().chunk(invalid)).toThrow(/provenance/u);
    expect(() =>
      new MaterialChunker().chunk({ ...document, text: `${document.text} orphaned` }),
    ).toThrow(/without unit provenance/u);
    expect(() => new MaterialChunker({ maxTokens: 901 })).toThrow(TypeError);
    expect(() => new MaterialChunker({ overlapTokens: 500 })).toThrow(TypeError);
  });
});

interface UnitInput {
  readonly headings: readonly string[];
  readonly page?: number;
  readonly text: string;
  readonly url?: string;
}

function parsedDocument(
  inputs: readonly UnitInput[],
  sourceType: 'pdf' | 'txt' | 'url' = 'txt',
): ParsedMaterialDocument {
  let text = '';
  const units = inputs.map((input) => {
    if (text) text += '\n\n';
    const charStart = text.length;
    text += input.text;
    return {
      locator: {
        char_end: text.length,
        char_start: charStart,
        headings: input.headings,
        page: input.page ?? null,
        url: input.url ?? null,
      },
      text: input.text,
      text_hash: createHash('sha256').update(input.text).digest('hex'),
    };
  });
  return {
    content_hash: 'a'.repeat(64),
    language: 'zh-CN',
    metadata: { page_count: sourceType === 'pdf' ? inputs.length : null, source_type: sourceType },
    parser_version: 'material-parser/1.0.0',
    text,
    title: 'Chunking fixture',
    units,
    warnings: [],
  };
}

function words(prefix: string, count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}${String(index).padStart(4, '0')}`,
  ).join(' ');
}
