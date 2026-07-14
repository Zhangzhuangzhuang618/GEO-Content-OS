import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { MaterialParserError } from './parser.errors.js';
import { MaterialParser } from './material.parser.js';
import { sha256 } from './normalization.js';
import type { MaterialSourceType, ParseMaterialInput } from './parser.types.js';

describe('MaterialParser', () => {
  it('normalizes UTF-8 text deterministically with exact character ranges', async () => {
    const parser = new MaterialParser();
    const body = Buffer.from(' 第一段\r\n包含\t单位  10 kg。\r\n\r\n第二段：2026-07-14。 ', 'utf8');
    const first = await parser.parse(source(body, 'txt', 'text/plain'));
    const second = await parser.parse(source(body, 'txt', 'text/plain'));
    expect(first).toEqual(second);
    expect(first.text).toBe('第一段\n包含 单位 10 kg。\n\n第二段：2026-07-14。');
    expect(first.units).toHaveLength(2);
    assertLocators(first.text, first.units);
    expect(first.units[0]?.locator).toMatchObject({ page: null, url: null });
    expect(first.units[0]?.text_hash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('extracts semantic HTML blocks, heading paths, tables, and canonical URL locators', async () => {
    const parser = new MaterialParser();
    const body = Buffer.from(
      '<html><body><nav>menu</nav><main><h1>产品 X</h1><p>将于 2026 年发布。</p><table><tr><th>型号</th><th>价格</th></tr><tr><td>X1</td><td>100 元</td></tr></table><script>steal()</script></main></body></html>',
      'utf8',
    );
    const result = await parser.parse(
      source(body, 'url', 'text/html; charset=utf-8', 'https://EXAMPLE.com:443/a#section'),
    );
    expect(result.text).not.toContain('steal');
    expect(result.text).toContain('型号 | 价格');
    expect(result.text).toContain('X1 | 100 元');
    expect(result.warnings).toEqual([]);
    expect(result.units.every((unit) => unit.locator.url === 'https://example.com/a')).toBe(true);
    expect(result.units.find((unit) => unit.text.includes('发布'))?.locator.headings).toEqual([
      '产品 X',
    ]);
    assertLocators(result.text, result.units);
  });

  it('parses text/plain URL sources allowed by the safe fetch Adapter', async () => {
    const body = Buffer.from('第一段。\n\n第二段。', 'utf8');
    const result = await new MaterialParser().parse(
      source(body, 'url', 'text/plain', 'https://example.com/source.txt#part'),
    );
    expect(result.text).toBe('第一段。\n\n第二段。');
    expect(result.units).toHaveLength(2);
    expect(
      result.units.every((unit) => unit.locator.url === 'https://example.com/source.txt'),
    ).toBe(true);
    assertLocators(result.text, result.units);
  });

  it('parses DOCX paragraphs, headings, and table key/value rows without reading embedded files', async () => {
    const parser = new MaterialParser();
    const body = createDocx();
    const result = await parser.parse(source(body, 'docx', DOCX_MIME));
    expect(result.text).toContain('企业资料');
    expect(result.text).toContain('发布时间为 2026 年。');
    expect(result.text).toContain('字段 | 值');
    expect(result.text).toContain('型号 | X1');
    expect(result.units.find((unit) => unit.text.includes('发布时间'))?.locator.headings).toEqual([
      '企业资料',
    ]);
    expect(result.metadata).toEqual({ page_count: null, source_type: 'docx' });
    assertLocators(result.text, result.units);
  });

  it('parses a real PDF byte stream and preserves page locators', async () => {
    const parser = new MaterialParser();
    const body = createPdf('Page one evidence 2026');
    const result = await parser.parse(source(body, 'pdf', 'application/pdf'));
    expect(result.text).toContain('Page one evidence 2026');
    expect(result.metadata).toEqual({ page_count: 1, source_type: 'pdf' });
    expect(result.units).toHaveLength(1);
    expect(result.units[0]?.locator).toMatchObject({ page: 1, url: null });
    assertLocators(result.text, result.units);
  });

  it('returns frozen structured failures for unsupported, empty, missing-locator, and invalid inputs', async () => {
    const parser = new MaterialParser({ maxCharacters: 8 });
    await expect(
      parser.parse(source(Buffer.from([0x89, 0x50]), 'image', 'image/png')),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MIME' });
    await expect(
      parser.parse(source(Buffer.from('<p>text</p>'), 'url', 'text/html')),
    ).rejects.toMatchObject({ code: 'LOCATOR_MISSING' });
    await expect(
      parser.parse(
        source(
          Buffer.from('<script>only script</script>'),
          'url',
          'text/html',
          'https://example.com',
        ),
      ),
    ).rejects.toMatchObject({ code: 'PARSE_EMPTY' });
    await expect(
      parser.parse(source(Buffer.from('more than eight characters'), 'txt', 'text/plain')),
    ).rejects.toMatchObject({ code: 'PARSE_EMPTY' });
    await expect(
      parser.parse(source(Buffer.from([0xff, 0xfe]), 'txt', 'text/plain')),
    ).rejects.toBeInstanceOf(MaterialParserError);
    await expect(
      parser.parse(source(Buffer.from('text'), 'pdf', 'text/plain')),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MIME' });
  });

  it('rejects a provenance hash that does not match the body', async () => {
    const body = Buffer.from('trusted source');
    await expect(
      new MaterialParser().parse({
        ...source(body, 'txt', 'text/plain'),
        contentHash: '0'.repeat(64),
      }),
    ).rejects.toThrow('contentHash does not match');
  });

  it('rejects malformed and expansion-bomb DOCX archives before conversion', async () => {
    const parser = new MaterialParser();
    await expect(
      parser.parse(source(Buffer.from('PK\u0003\u0004not-a-docx'), 'docx', DOCX_MIME)),
    ).rejects.toMatchObject({ code: 'PARSE_EMPTY' });

    const bomb = Buffer.from(createDocx());
    const centralEntry = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(centralEntry).toBeGreaterThanOrEqual(0);
    bomb.writeUInt32LE(200 * 1_024 * 1_024, centralEntry + 24);
    await expect(parser.parse(source(bomb, 'docx', DOCX_MIME))).rejects.toMatchObject({
      code: 'PARSE_EMPTY',
    });
  });
});

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function source(
  body: Uint8Array,
  sourceType: MaterialSourceType,
  mimeType: string,
  url?: string,
): ParseMaterialInput {
  return {
    body,
    contentHash: sha256(body),
    language: 'zh-CN',
    mimeType,
    sourceType,
    title: '企业资料',
    ...(url ? { url } : {}),
  };
}

function assertLocators(
  text: string,
  units: readonly {
    readonly locator: { readonly char_end: number; readonly char_start: number };
    readonly text: string;
  }[],
): void {
  let previousEnd = 0;
  for (const unit of units) {
    expect(unit.locator.char_start).toBeGreaterThanOrEqual(previousEnd);
    expect(text.slice(unit.locator.char_start, unit.locator.char_end)).toBe(unit.text);
    previousEnd = unit.locator.char_end;
  }
}

function createDocx(): Buffer {
  const files = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    'word/document.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>企业资料</w:t></w:r></w:p><w:p><w:r><w:t>发布时间为 2026 年。</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>字段</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>值</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>型号</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>X1</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>',
    ),
  };
  return Buffer.from(zipSync(files, { level: 1 }));
}

function createPdf(text: string): Buffer {
  const escaped = text.replace(/[()\\]/gu, (character) => `\\${character}`);
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}
