import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SohuBrowserConfig } from './config.js';
import { PlaywrightSohuPageDriver } from './page-driver.js';

interface SubmittedPublication {
  readonly abstract: string;
  readonly aiDeclared: boolean;
  readonly body: string;
  readonly imageCount: number;
  readonly title: string;
}

describe('Sohu local browser simulator', () => {
  let baseUrl = '';
  let duplicateRows = false;
  let articlePermission = true;
  let profileRoot = '';
  let server: ReturnType<typeof createServer>;
  let submitted: SubmittedPublication | null = null;

  beforeEach(async () => {
    duplicateRows = false;
    articlePermission = true;
    submitted = null;
    profileRoot = await mkdtemp(join(tmpdir(), 'geo-sohu-e2e-'));
    server = createServer((request, response) =>
      route(
        request,
        response,
        () => submitted,
        () => duplicateRows,
        () => articlePermission,
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

  it('logs in with WeChat, fills Quill, declares AI content, publishes once and reconciles', async () => {
    const driver = new PlaywrightSohuPageDriver(config(baseUrl, profileRoot));
    const accountId = '00000000-0000-4000-8000-000000000150';
    const profilePath = join(profileRoot, accountId);
    try {
      const login = await driver.startLogin(accountId, profilePath);
      expect(login.qrPng.byteLength).toBeGreaterThan(0);
      expect(await driver.waitForAuthentication(accountId, login.expiresAt)).toBe(true);
      const storageState = await driver.exportStorageState(accountId);
      let preSubmitBytes = 0;
      const result = await driver.submit(
        {
          accountId,
          contentFingerprint: 'a'.repeat(64),
          images: [
            {
              assetId: '00000000-0000-4000-8000-000000000151',
              body: Buffer.from('simulated-image'),
              mimeType: 'image/png',
              role: 'body',
            },
          ],
          payload: payload('搜狐号发布仿真测试'),
          profilePath,
          storageStateJson: storageState,
        },
        async (png) => {
          preSubmitBytes = png.byteLength;
        },
      );
      expect(preSubmitBytes).toBeGreaterThan(0);
      expect(submitted).toMatchObject({
        abstract: '这是搜狐号自动发布摘要。',
        aiDeclared: true,
        imageCount: 1,
        title: '搜狐号发布仿真测试',
      });
      expect(submitted?.body).toContain('第五段用于满足平台结构要求');
      expect(result).toMatchObject({ externalId: 'simulator-150', status: 'processing' });
    } finally {
      await driver.close();
    }
  });

  it('stops when the content list contains multiple matching publications', async () => {
    const driver = new PlaywrightSohuPageDriver(config(baseUrl, profileRoot));
    const accountId = '00000000-0000-4000-8000-000000000150';
    const profilePath = join(profileRoot, accountId);
    try {
      const login = await driver.startLogin(accountId, profilePath);
      expect(await driver.waitForAuthentication(accountId, login.expiresAt)).toBe(true);
      submitted = {
        abstract: '摘要',
        aiDeclared: true,
        body: '正文',
        imageCount: 0,
        title: '重复匹配测试文章',
      };
      duplicateRows = true;
      await expect(
        driver.reconcile(
          accountId,
          profilePath,
          {
            contentFingerprint: 'a'.repeat(64),
            submittedAfter: new Date(Date.now() - 60_000),
            title: '重复匹配测试文章',
          },
          await driver.exportStorageState(accountId),
        ),
      ).rejects.toMatchObject({ code: 'MULTIPLE_MATCHES' });
    } finally {
      await driver.close();
    }
  });

  it('reports an authenticated account that cannot publish articles', async () => {
    const driver = new PlaywrightSohuPageDriver(config(baseUrl, profileRoot));
    const accountId = '00000000-0000-4000-8000-000000000152';
    const profilePath = join(profileRoot, accountId);
    articlePermission = false;
    try {
      const login = await driver.startLogin(accountId, profilePath);
      await expect(driver.waitForAuthentication(accountId, login.expiresAt)).rejects.toMatchObject({
        code: 'ACCOUNT_PERMISSION_REQUIRED',
      });
    } finally {
      await driver.close();
    }
  });
});

function payload(title: string) {
  return {
    abstract: '这是搜狐号自动发布摘要。',
    ai_generated: true as const,
    body_asset_ids: ['00000000-0000-4000-8000-000000000151'],
    body_html:
      '<p>第一段说明发布背景。</p><p>第二段说明操作流程。</p><p>第三段说明核验要求。</p><p>第四段说明失败处理。</p><p>第五段用于满足平台结构要求。</p>',
    body_text:
      '第一段说明发布背景。\n\n第二段说明操作流程。\n\n第三段说明核验要求。\n\n第四段说明失败处理。\n\n第五段用于满足平台结构要求。',
    citation_links: [],
    content_type: 'article',
    cover_asset_id: null,
    original: false as const,
    platform_code: 'sohu' as const,
    rule_version: 'sohu-render-rules@1.0.0' as const,
    schema_version: 'sohu-payload@1' as const,
    title,
  };
}

function config(baseUrl: string, profileRoot: string): SohuBrowserConfig {
  return Object.freeze({
    databaseUrl: 'postgresql://unused',
    editorUrl: `${baseUrl}/editor`,
    gatewayToken: 'x'.repeat(32),
    headless: true,
    healthPort: 9096,
    loginUrl: `${baseUrl}/signin`,
    manageUrl: `${baseUrl}/manage`,
    navigationTimeoutMs: 5_000,
    profileRoot,
    simulator: true,
  });
}

function route(
  request: IncomingMessage,
  response: ServerResponse,
  readSubmitted: () => SubmittedPublication | null,
  readDuplicateRows: () => boolean,
  readArticlePermission: () => boolean,
  saveSubmitted: (value: SubmittedPublication) => void,
): void {
  if (request.url === '/qr.svg') {
    response.writeHead(200, { 'content-type': 'image/svg+xml' });
    response.end(
      '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" fill="white"/><rect x="20" y="20" width="200" height="200" fill="black"/></svg>',
    );
    return;
  }
  if (request.url === '/signin') {
    return html(
      response,
      `<div data-role="login-btn">登录</div>
       <div class="login-modal" style="display:none"><a data-login="weChat">微信登录</a></div>
       <img class="qrcode" src="/qr.svg" style="display:none">
       <script>
         document.querySelector('[data-role="login-btn"]').onclick=()=>{document.querySelector('.login-modal').style.display='block'};
         document.querySelector('[data-login="weChat"]').onclick=()=>{document.querySelector('.qrcode').style.display='block';setTimeout(()=>{document.cookie='sohu-auth=yes; path=/';location.href='/authenticated'},1500)};
       </script>`,
    );
  }
  if (request.url === '/authenticated')
    return html(response, '<div class="user-info">已登录</div>');
  if (request.url === '/editor') {
    if (!authenticated(request)) return redirect(response, '/signin');
    if (!readArticlePermission()) return redirect(response, '/manage');
    if (!request.headers.cookie?.includes('sohu-editor-entry=yes'))
      return redirect(response, '/manage');
    return html(
      response,
      `<div class="user-info">已登录</div>
       <input placeholder="请输入标题（5-72字）">
       <div id="editor"><div class="ql-editor" contenteditable="true"></div></div>
       <textarea placeholder="请输入摘要"></textarea>
       <button class="ql-image" type="button">图片</button><input id="image-file" type="file" accept="image/*" style="display:none">
       <label>无特别声明<input type="radio" name="resource" value="0"></label>
       <label>包含AI创作内容<input type="radio" name="resource" value="2"></label>
       <div id="result"></div><button id="publish" type="button">发布</button>
       <script>
         const imageFile=document.querySelector('#image-file');
         document.querySelector('.ql-image').onclick=()=>imageFile.click();
         imageFile.onchange=()=>{const image=document.createElement('img');image.alt='正文配图';document.querySelector('.ql-editor').append(image)};
         document.querySelector('#publish').onclick=async()=>{
           const result=await fetch('/publish',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
             abstract:document.querySelector('textarea').value,
             aiDeclared:document.querySelector('input[value="2"]').checked,
             body:document.querySelector('.ql-editor').innerText,
             imageCount:document.querySelectorAll('.ql-editor img').length,
             title:document.querySelector('input').value
           })});
           if(result.ok) document.querySelector('#result').textContent='审核中';
         };
       </script>`,
    );
  }
  if (request.method === 'POST' && request.url === '/publish') {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const publication = JSON.parse(
        Buffer.concat(chunks).toString('utf8'),
      ) as SubmittedPublication;
      setTimeout(() => saveSubmitted(publication), 500);
      json(response, { success: true });
    });
    return;
  }
  if (request.url === '/manage') {
    if (!authenticated(request)) return redirect(response, '/signin');
    if (!readArticlePermission()) {
      return html(
        response,
        '<div class="user-info">已登录</div><p>您的账号未实名</p><p>仅支持发布动态。</p>',
      );
    }
    const item = readSubmitted();
    const row = item
      ? `<div class="article-item"><a href="/news?id=simulator-150">${escapeHtml(item.title)}</a>审核中</div>`
      : '';
    const draft = item
      ? `<div class="article-item"><a href="/news?id=simulator-draft">${escapeHtml(item.title)}</a>草稿</div>`
      : '';
    return html(
      response,
      `<div id="auth-shell" style="display:none"><div class="user-info">已登录</div><button id="publish-entry" onclick="document.cookie='sohu-editor-entry=yes; path=/';location.href='/editor'">发布内容</button></div><main>${row}${draft}${readDuplicateRows() ? row.replaceAll('simulator-150', 'simulator-151') : ''}</main>
       <script>setTimeout(()=>{document.querySelector('#auth-shell').style.display='block'},100)</script>`,
    );
  }
  response.writeHead(404).end();
}

function authenticated(request: IncomingMessage): boolean {
  return request.headers.cookie?.includes('sohu-auth=yes') === true;
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { location }).end();
}

function html(response: ServerResponse, body: string): void {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><html><body>${body}</body></html>`);
}

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
}
