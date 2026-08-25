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

  it('logs in with an ephemeral account password without persisting the secret', async () => {
    const driver = new PlaywrightSohuPageDriver(config(baseUrl, profileRoot));
    const accountId = '00000000-0000-4000-8000-000000000153';
    try {
      const login = await driver.startLogin(accountId, join(profileRoot, accountId), {
        accepted_terms: true,
        account: 'publisher@example.com',
        method: 'password',
        password: 'ephemeral-password',
      });
      expect(login.qrPng.byteLength).toBe(0);
      const storageState = await driver.exportStorageState(accountId);
      expect(storageState).not.toMatch(/publisher@example\.com|ephemeral-password/u);
      expect(
        await driver.verifyAuthenticated(accountId, join(profileRoot, accountId), storageState),
      ).toBe(true);
    } finally {
      await driver.close();
    }
  });

  it('uses a manual image CAPTCHA before sending and verifying an SMS code', async () => {
    const driver = new PlaywrightSohuPageDriver(config(baseUrl, profileRoot));
    const accountId = '00000000-0000-4000-8000-000000000154';
    const profilePath = join(profileRoot, accountId);
    try {
      const prepared = await driver.startLogin(accountId, profilePath, {
        method: 'sms_prepare',
        mobile: '13800138000',
      });
      expect(prepared.captchaPng?.byteLength).toBeGreaterThan(0);
      const sent = await driver.startLogin(accountId, profilePath, {
        accepted_terms: true,
        image_captcha: 'ABCD',
        method: 'sms_send',
        mobile: '13800138000',
      });
      expect(sent.smsCodeRequired).toBe(true);
      const verified = await driver.startLogin(accountId, profilePath, {
        accepted_terms: true,
        method: 'sms_verify',
        mobile: '13800138000',
        sms_code: '123456',
      });
      expect(verified.qrPng.byteLength).toBe(0);
      expect(await driver.exportStorageState(accountId)).not.toContain('13800138000');
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
  if (request.url === '/captcha.svg') {
    response.writeHead(200, { 'content-type': 'image/svg+xml' });
    response.end(
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="48"><rect width="120" height="48" fill="white"/><text x="12" y="32">ABCD</text></svg>',
    );
    return;
  }
  if (request.url === '/signin') {
    return html(
      response,
      `<div data-role="login-btn">登录</div>
       <div class="login-modal" style="display:none">
         <button type="button">账号登录</button><button type="button">手机登录</button>
         <input data-role="user-passport"><input data-role="user-secret" type="password">
         <input data-role="submit-user" type="button" value="登录">
         <input data-role="mobilenum"><div data-role="mobilenum-captcha"><input data-role="mobilenum-tip"><img class="captcha-pic" src="/captcha.svg"></div>
         <input data-role="mobilenum-dynamic"><a data-role="dynamic-get">获取验证码</a>
         <input data-role="submit-mobile" type="button" value="登录/注册">
         <em data-role="radio-protocol" class="radio-icon" style="display:inline-block;width:16px;height:16px"></em>
         <a data-login="weChat">微信登录</a>
       </div>
       <img class="qrcode" src="/qr.svg" style="display:none">
       <script>
         document.querySelector('[data-role="login-btn"]').onclick=()=>{document.querySelector('.login-modal').style.display='block'};
         document.querySelector('[data-role="radio-protocol"]').onclick=(event)=>event.target.classList.toggle('radio-icon-sel');
         document.querySelector('[data-role="submit-user"]').onclick=()=>{if(!document.querySelector('[data-role="radio-protocol"]').classList.contains('radio-icon-sel'))return;document.cookie='sohu-auth=yes; path=/';location.href='/authenticated'};
         document.querySelector('[data-role="dynamic-get"]').onclick=(event)=>{event.target.textContent='59秒后重试'};
         document.querySelector('[data-role="submit-mobile"]').onclick=()=>{if(!document.querySelector('[data-role="radio-protocol"]').classList.contains('radio-icon-sel'))return;document.cookie='sohu-auth=yes; path=/';location.href='/authenticated'};
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
