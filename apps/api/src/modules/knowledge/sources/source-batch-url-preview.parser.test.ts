import ExcelJS from 'exceljs';
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';

import { SourceUploadValidationError } from './source.errors.js';
import { previewBatchUrlFile } from './source-batch-url-preview.parser.js';

describe('batch URL spreadsheet preview', () => {
  it('reads hyperlinks, selects the expected sheet, and labels invalid and duplicate rows', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('说明');
    const sheet = workbook.addWorksheet('详细URL列表');
    sheet.getCell('B1').value = '标题';
    sheet.getCell('D1').value = 'URL';
    sheet.getCell('B2').value = '产品页';
    sheet.getCell('D2').value = {
      hyperlink: 'https://example.com/product#intro',
      text: '查看原文',
    };
    sheet.getCell('B3').value = '重复产品页';
    sheet.getCell('D3').value = 'https://example.com/product';
    sheet.getCell('D4').value = 'ftp://example.com/file';
    sheet.getCell('D5').value = {
      formula: 'HYPERLINK("https://example.com/formula","访问")',
      result: '访问',
    };

    const preview = await previewBatchUrlFile({
      body: Buffer.from(await workbook.xlsx.writeBuffer()),
      filename: 'urls.xlsx',
      sheetName: null,
      startRow: 2,
      titleColumn: 'B',
      urlColumn: 'D',
    });

    expect(preview).toMatchObject({
      duplicate_rows: 1,
      invalid_rows: 1,
      ready_rows: 2,
      sheet_name: '详细URL列表',
      sheets: ['说明', '详细URL列表'],
      total_rows: 4,
    });
    expect(preview.rows).toEqual([
      {
        message: null,
        row_number: 2,
        status: 'ready',
        title: '产品页',
        url: 'https://example.com/product',
      },
      {
        message: '文件内重复，已跳过',
        row_number: 3,
        status: 'duplicate',
        title: '重复产品页',
        url: 'https://example.com/product',
      },
      {
        message: '不是有效的 HTTP(S) 地址',
        row_number: 4,
        status: 'invalid',
        title: null,
        url: 'ftp://example.com/file',
      },
      {
        message: null,
        row_number: 5,
        status: 'ready',
        title: null,
        url: 'https://example.com/formula',
      },
    ]);
  });

  it('parses quoted UTF-8 CSV rows and rejects unsupported files', async () => {
    const preview = await previewBatchUrlFile({
      body: Buffer.from('标题,来源,说明,URL\n"广州,服务",,,https://example.com/a\n', 'utf8'),
      filename: 'urls.csv',
      sheetName: null,
      startRow: 2,
      titleColumn: 'A',
      urlColumn: 'D',
    });
    expect(preview.rows).toEqual([
      {
        message: null,
        row_number: 2,
        status: 'ready',
        title: '广州,服务',
        url: 'https://example.com/a',
      },
    ]);

    await expect(
      previewBatchUrlFile({
        body: Buffer.from('x'),
        filename: 'urls.txt',
        sheetName: null,
        startRow: 2,
        titleColumn: null,
        urlColumn: 'D',
      }),
    ).rejects.toBeInstanceOf(SourceUploadValidationError);
  });

  it('automatically starts after a URL header when start_row is omitted', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('详细URL列表');
    sheet.getCell('D1').value = '说明';
    sheet.getCell('D4').value = 'URL';
    sheet.getCell('D5').value = 'https://example.com/first';
    const preview = await previewBatchUrlFile({
      body: Buffer.from(await workbook.xlsx.writeBuffer()),
      filename: 'urls.xlsx',
      sheetName: null,
      startRow: null,
      titleColumn: null,
      urlColumn: 'D',
    });
    expect(preview.start_row).toBe(5);
    expect(preview.rows).toHaveLength(1);
  });
});
