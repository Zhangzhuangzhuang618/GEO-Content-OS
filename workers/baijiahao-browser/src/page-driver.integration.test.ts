import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BaijiahaoBrowserConfig } from './config.js';
import { PlaywrightBaijiahaoPageDriver } from './page-driver.js';

describe('Baijiahao local browser simulator', () => {
  let baseUrl = '';
  let duplicateRows = false;
  let profileRoot = '';
  let server: ReturnType<typeof createServer>;
  let submitted: { fingerprint: string; title: string } | null = null;
  let validManageSignature = true;

  beforeEach(async () => {
    duplicateRows = false;
    submitted = null;
    validManageSignature = true;
    profileRoot = await mkdtemp(join(tmpdir(), 'geo-baijiahao-e2e-'));
    server = createServer((request, response) =>
      route(
        request,
        response,
        () => submitted,
        () => duplicateRows,
        () => validManageSignature,
        (value) => {
          submitted = value;
        },
      ),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Simulator did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(profileRoot, { force: true, recursive: true });
  });

  it('logs in, captures pre-submit state, submits once, and reconciles from content list', async () => {
    const driver = new PlaywrightBaijiahaoPageDriver(config(baseUrl, profileRoot));
    let recovered: PlaywrightBaijiahaoPageDriver | null = null;
    const accountId = '00000000-0000-4000-8000-000000000145';
    const profilePath = join(profileRoot, accountId);
    try {
      const login = await driver.startLogin(accountId, profilePath);
      expect(login.qrPng.byteLength).toBeGreaterThan(0);
      expect(await driver.waitForAuthentication(accountId, login.expiresAt)).toBe(true);
      const storageState = await driver.exportStorageState(accountId);
      await driver.close();
      recovered = new PlaywrightBaijiahaoPageDriver(config(baseUrl, profileRoot));
      expect(
        await recovered.verifyAuthenticated(
          accountId,
          join(profileRoot, 'recovered-profile'),
          storageState,
        ),
      ).toBe(true);
      let preSubmitBytes = 0;
      const result = await recovered.submit(
        {
          accountId,
          contentFingerprint: 'a'.repeat(64),
          images: [
            {
              assetId: '00000000-0000-4000-8000-000000000146',
              body: Buffer.from('simulated-cover'),
              mimeType: 'image/png',
              role: 'cover',
            },
            {
              assetId: '00000000-0000-4000-8000-000000000147',
              body: Buffer.from('simulated-body-image'),
              mimeType: 'image/jpeg',
              role: 'body',
            },
          ],
          payload: {
            abstract: '这是一段摘要',
            body_html: '<p>正文</p>',
            body_asset_ids: ['00000000-0000-4000-8000-000000000147'],
            body_text: '用于百家号浏览器仿真验证的正文内容。',
            citation_links: [],
            content_type: 'news',
            cover_asset_id: '00000000-0000-4000-8000-000000000146',
            platform_code: 'baijiahao',
            rule_version: 'baijiahao-render-rules@1.1.0',
            schema_version: 'baijiahao-payload@2',
            tags: ['搬家', '准备', '指南'],
            title: '百家号发布仿真测试',
          },
          profilePath,
          storageStateJson: storageState,
        },
        async (png) => {
          preSubmitBytes = png.byteLength;
        },
      );
      expect(preSubmitBytes).toBeGreaterThan(0);
      expect(result).toMatchObject({ externalId: 'simulator-145', status: 'processing' });
      const reconciled = await recovered.reconcile(
        accountId,
        profilePath,
        {
          contentFingerprint: 'a'.repeat(64),
          submittedAfter: new Date(Date.now() - 60_000),
          title: '百家号发布仿真测试',
        },
        storageState,
      );
      expect(reconciled?.externalId).toBe('simulator-145');
    } finally {
      await recovered?.close();
      await driver.close();
    }
  });

  it('stops when the content list contains multiple matching publications', async () => {
    const driver = new PlaywrightBaijiahaoPageDriver(config(baseUrl, profileRoot));
    const accountId = '00000000-0000-4000-8000-000000000145';
    const profilePath = join(profileRoot, accountId);
    try {
      const login = await driver.startLogin(accountId, profilePath);
      expect(await driver.waitForAuthentication(accountId, login.expiresAt)).toBe(true);
      submitted = { fingerprint: 'a'.repeat(64), title: '重复匹配测试' };
      duplicateRows = true;

      await expect(
        driver.reconcile(
          accountId,
          profilePath,
          {
            contentFingerprint: 'a'.repeat(64),
            submittedAfter: new Date(Date.now() - 60_000),
            title: '重复匹配测试',
          },
          await driver.exportStorageState(accountId),
        ),
      ).rejects.toMatchObject({ code: 'MULTIPLE_MATCHES' });
    } finally {
      await driver.close();
    }
  });

  it('stops when an empty management page no longer has the frozen list signature', async () => {
    const driver = new PlaywrightBaijiahaoPageDriver(config(baseUrl, profileRoot));
    const accountId = '00000000-0000-4000-8000-000000000145';
    const profilePath = join(profileRoot, accountId);
    try {
      const login = await driver.startLogin(accountId, profilePath);
      expect(await driver.waitForAuthentication(accountId, login.expiresAt)).toBe(true);
      validManageSignature = false;

      await expect(
        driver.reconcile(
          accountId,
          profilePath,
          {
            contentFingerprint: 'a'.repeat(64),
            submittedAfter: new Date(Date.now() - 60_000),
            title: '不存在的文章',
          },
          await driver.exportStorageState(accountId),
        ),
      ).rejects.toMatchObject({ code: 'PAGE_SIGNATURE_CHANGED' });
    } finally {
      await driver.close();
    }
  });
});

function config(baseUrl: string, profileRoot: string): BaijiahaoBrowserConfig {
  return Object.freeze({
    databaseUrl: 'postgresql://unused',
    editorUrl: `${baseUrl}/editor`,
    gatewayToken: 'x'.repeat(32),
    headless: true,
    healthPort: 9095,
    loginUrl: `${baseUrl}/login`,
    manageUrl: `${baseUrl}/manage`,
    navigationTimeoutMs: 5_000,
    profileRoot,
    simulator: true,
  });
}

function route(
  request: IncomingMessage,
  response: ServerResponse,
  readSubmitted: () => { fingerprint: string; title: string } | null,
  readDuplicateRows: () => boolean,
  hasManageSignature: () => boolean,
  saveSubmitted: (value: { fingerprint: string; title: string }) => void,
): void {
  if (request.url === '/v2/api/qrcode') {
    response.writeHead(200, { 'content-type': 'image/svg+xml' });
    response.end(
      '<svg xmlns="http://www.w3.org/2000/svg" width="265" height="265"><rect width="265" height="265" fill="white"/><rect x="20" y="20" width="225" height="225" fill="black"/></svg>',
    );
    return;
  }
  if (request.url === '/login') {
    return html(
      response,
      `
      <canvas width="1440" height="1755"></canvas>
      <button data-testid="bjh-login-btn">登录</button>
      <img data-testid="login-qr" style="display:none" src="/v2/api/qrcode">
      <div data-testid="account-menu" style="display:none">已登录</div>
      <script>
        document.querySelector('[data-testid=bjh-login-btn]').onclick=()=>{
          document.querySelector('[data-testid=login-qr]').style.display='block';
          setTimeout(()=>{localStorage.setItem('simulator-auth','yes');document.querySelector('[data-testid=account-menu]').style.display='block'},50);
        };
      </script>
    `,
    );
  }
  if (request.url === '/editor') {
    return html(
      response,
      `
      <div data-testid="account-menu" style="display:none">已登录</div>
      <input data-field="title"><textarea data-field="abstract"></textarea>
      <textarea data-field="body" contenteditable="true"></textarea>
      <input type="file" data-field="cover" accept="image/*">
      <input type="file" data-field="body-images" accept="image/*" multiple>
      <input data-field="tags"><input data-field="fingerprint">
      <select data-field="category"><option value="news">news</option></select>
      <label data-testid="not-original"><input type="radio" name="original">非原创</label>
      <button data-testid="submit">发布</button>
      <script>
        if(localStorage.getItem('simulator-auth')==='yes') document.querySelector('[data-testid=account-menu]').style.display='block';
        document.querySelector('[data-testid=submit]').onclick=async()=>{
          await fetch('/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
            title:document.querySelector('[data-field=title]').value,
            fingerprint:document.querySelector('[data-field=fingerprint]').value
          })});
          location.href='/manage';
        };
      </script>
    `,
    );
  }
  if (request.method === 'POST' && request.url === '/submit') {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      saveSubmitted(
        JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          fingerprint: string;
          title: string;
        },
      );
      response.writeHead(204).end();
    });
    return;
  }
  if (request.url === '/manage') {
    const item = readSubmitted();
    const row = item
      ? `<div data-publication-row data-title="${escapeHtml(item.title)}" data-content-fingerprint="${item.fingerprint}" data-submitted-at="${new Date().toISOString()}" data-external-id="simulator-145" data-status="processing"><a href="/article/id=simulator-145">${escapeHtml(item.title)}</a>审核中</div>`
      : '';
    return html(
      response,
      `
      <div data-testid="account-menu" style="display:none">已登录</div>
      <div ${hasManageSignature() ? 'data-testid="content-list"' : ''}>
        ${row}${readDuplicateRows() ? row.replaceAll('simulator-145', 'simulator-146') : ''}
      </div>
      <script>if(localStorage.getItem('simulator-auth')==='yes') document.querySelector('[data-testid=account-menu]').style.display='block'</script>
    `,
    );
  }
  response.writeHead(404).end();
}

function html(response: ServerResponse, body: string): void {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><html><body>${body}</body></html>`);
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
}
