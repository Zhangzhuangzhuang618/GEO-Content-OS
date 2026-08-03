import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';

import { KeywordValidationError } from './keyword.errors.js';
import { previewKeywordWorkbook } from './keyword-import.parser.js';

describe('keyword spreadsheet preflight', () => {
  it('detects the workbook header, maps intents, and folds deterministic word-order variants', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('关键词库');
    sheet.addRow(['广州搬家业务关键词库']);
    sheet.addRow(['说明']);
    sheet.addRow([]);
    sheet.addRow([
      '序号',
      '关键词',
      '地域',
      '服务类型',
      '搜索意图',
      '场景',
      '修饰词/路线',
      '建议页面类型',
      '生成来源',
    ]);
    sheet.addRow([
      1,
      '广州荔湾附近搬家',
      '广州荔湾',
      '搬家',
      '本地搜索',
      '居民搬家',
      '附近',
      '服务页',
      '地域×服务×修饰词',
    ]);
    sheet.addRow([
      2,
      '广州荔湾搬家附近',
      '广州荔湾',
      '搬家',
      '本地搜索',
      '居民搬家',
      '附近',
      '服务页',
      '地域×服务×修饰词',
    ]);
    sheet.addRow([
      3,
      '广州荔湾搬家多少钱',
      '广州荔湾',
      '搬家',
      '价格咨询',
      '居民搬家',
      '多少钱',
      '报价页',
      '地域×服务×修饰词',
    ]);
    sheet.addRow([4, '未知词', '广州', '搬家', '未知意图', '居民搬家', '', '服务页', '手工']);

    const preview = await previewKeywordWorkbook({
      body: Buffer.from(await workbook.xlsx.writeBuffer()),
      fileName: '广州搬家关键词库.xlsx',
      sheetName: null,
    });

    expect(preview).toMatchObject({
      foldedRowCount: 1,
      headerRow: 4,
      invalidRowCount: 1,
      sheetName: '关键词库',
      totalRowCount: 4,
    });
    expect(preview.candidates).toHaveLength(2);
    expect(preview.candidates[0]).toMatchObject({
      intents: ['commercial', 'transactional'],
      sourceIntent: '本地搜索',
      synonyms: ['广州荔湾搬家附近'],
      term: '广州荔湾附近搬家',
    });
    expect(preview.candidates[1]?.intents).toEqual(['informational', 'commercial']);
    expect(preview.summary.source_intents).toEqual([
      { count: 1, label: '价格咨询' },
      { count: 1, label: '本地搜索' },
    ]);
  });

  it('rejects workbooks without the required header', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Sheet1').addRow(['term', 'intent']);
    await expect(
      previewKeywordWorkbook({
        body: Buffer.from(await workbook.xlsx.writeBuffer()),
        fileName: 'keywords.xlsx',
        sheetName: null,
      }),
    ).rejects.toBeInstanceOf(KeywordValidationError);
  });

  it('accepts valid workbooks that use an x-prefixed SpreadsheetML namespace', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('关键词库');
    sheet.addRow(['关键词', '搜索意图', '建议页面类型']);
    sheet.addRow(['广州搬家', '本地搜索', '服务页']);
    const zip = await JSZip.loadAsync(Buffer.from(await workbook.xlsx.writeBuffer()));
    const spreadsheetNamespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    for (const [path, entry] of Object.entries(zip.files)) {
      if (entry.dir || !path.endsWith('.xml')) continue;
      const xml = await entry.async('string');
      if (!xml.includes(`xmlns="${spreadsheetNamespace}"`)) continue;
      zip.file(
        path,
        xml
          .replace(`xmlns="${spreadsheetNamespace}"`, `xmlns:x="${spreadsheetNamespace}"`)
          .replace(/<(\/?)([A-Za-z][A-Za-z0-9]*)(?=[\s/>])/g, '<$1x:$2'),
      );
    }

    const preview = await previewKeywordWorkbook({
      body: await zip.generateAsync({ type: 'nodebuffer' }),
      fileName: 'prefixed.xlsx',
      sheetName: null,
    });

    expect(preview.candidates).toHaveLength(1);
    expect(preview.candidates[0]?.term).toBe('广州搬家');
  });
});
