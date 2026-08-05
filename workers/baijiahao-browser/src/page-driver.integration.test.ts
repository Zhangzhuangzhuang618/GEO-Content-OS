import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BaijiahaoBrowserConfig } from './config.js';
import { PlaywrightBaijiahaoPageDriver } from './page-driver.js';

type SubmittedPublication = {
  aiGenerated: boolean;
  bodyInputRegistered: boolean;
  bodyImagesUploaded: number;
  coverUploaded: boolean;
  fingerprint: string;
  title: string;
};

describe('Baijiahao local browser simulator', () => {
  let baseUrl = '';
  let duplicateRows = false;
  let manageStartsAtHome = false;
  let profileRoot = '';
  let server: ReturnType<typeof createServer>;
  let submitted: SubmittedPublication | null = null;
  let validEditorSignature = true;
  let validManageSignature = true;

  beforeEach(async () => {
    duplicateRows = false;
    manageStartsAtHome = false;
    submitted = null;
    validEditorSignature = true;
    validManageSignature = true;
    profileRoot = await mkdtemp(join(tmpdir(), 'geo-baijiahao-e2e-'));
    server = createServer((request, response) =>
      route(
        request,
        response,
        () => submitted,
        () => duplicateRows,
        () => validEditorSignature,
        () => validManageSignature,
        () => manageStartsAtHome,
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
            {
              assetId: '00000000-0000-4000-8000-000000000148',
              body: Buffer.from('second-simulated-body-image'),
              mimeType: 'image/png',
              role: 'body',
            },
          ],
          payload: {
            abstract: '这是一段摘要',
            body_html: '<p>正文</p>',
            body_asset_ids: [
              '00000000-0000-4000-8000-000000000147',
              '00000000-0000-4000-8000-000000000148',
            ],
            body_text: '用于百家号浏览器仿真验证的正文内容。\n\n1. 第一步\n2. 第二步\n\n收尾。',
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
      expect(submitted).toMatchObject({
        aiGenerated: true,
        bodyInputRegistered: true,
        bodyImagesUploaded: 2,
        coverUploaded: true,
      });
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
      submitted = {
        aiGenerated: true,
        bodyInputRegistered: true,
        bodyImagesUploaded: 0,
        coverUploaded: true,
        fingerprint: 'a'.repeat(64),
        title: '重复匹配测试',
      };
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

  it('keeps an authenticated session when the editor signature is temporarily unavailable', async () => {
    const driver = new PlaywrightBaijiahaoPageDriver(config(baseUrl, profileRoot));
    const accountId = '00000000-0000-4000-8000-000000000145';
    const profilePath = join(profileRoot, accountId);
    try {
      const login = await driver.startLogin(accountId, profilePath);
      expect(await driver.waitForAuthentication(accountId, login.expiresAt)).toBe(true);
      validEditorSignature = false;

      await expect(
        driver.verifyAuthenticated(
          accountId,
          profilePath,
          await driver.exportStorageState(accountId),
        ),
      ).resolves.toBe(true);
    } finally {
      await driver.close();
    }
  });

  it('opens content management from the authenticated home page before reconciling', async () => {
    const driver = new PlaywrightBaijiahaoPageDriver(config(baseUrl, profileRoot));
    const accountId = '00000000-0000-4000-8000-000000000145';
    const profilePath = join(profileRoot, accountId);
    try {
      const login = await driver.startLogin(accountId, profilePath);
      expect(await driver.waitForAuthentication(accountId, login.expiresAt)).toBe(true);
      submitted = {
        aiGenerated: true,
        bodyInputRegistered: true,
        bodyImagesUploaded: 0,
        coverUploaded: true,
        fingerprint: 'a'.repeat(64),
        title: '首页跳转后的核验测试',
      };
      manageStartsAtHome = true;

      await expect(
        driver.reconcile(
          accountId,
          profilePath,
          {
            contentFingerprint: 'a'.repeat(64),
            submittedAfter: new Date(Date.now() - 60_000),
            title: '首页跳转后的核验测试',
          },
          await driver.exportStorageState(accountId),
        ),
      ).resolves.toMatchObject({ externalId: 'simulator-145', status: 'processing' });
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
  readSubmitted: () => SubmittedPublication | null,
  readDuplicateRows: () => boolean,
  hasEditorSignature: () => boolean,
  hasManageSignature: () => boolean,
  manageStartsAtHome: () => boolean,
  saveSubmitted: (value: SubmittedPublication) => void,
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
      <nav data-testid="authenticated-home" style="display:none">
        <button>发布作品</button><span>内容管理</span><span>个人中心</span>
      </nav>
      <button data-testid="bjh-login-btn">登录</button>
      <img data-testid="login-qr" style="display:none" src="/v2/api/qrcode">
      <script>
        if(localStorage.getItem('simulator-auth')==='yes') {
          document.querySelector('[data-testid=authenticated-home]').style.display='block';
          document.querySelector('[data-testid=bjh-login-btn]').style.display='none';
        }
        document.querySelector('[data-testid=bjh-login-btn]').onclick=()=>{
          document.querySelector('[data-testid=login-qr]').style.display='block';
          setTimeout(()=>{localStorage.setItem('simulator-auth','yes');location.href='/login-complete'},500);
        };
      </script>
    `,
    );
  }
  if (request.url === '/login-complete') {
    return html(response, '<main>登录完成</main>');
  }
  if (request.url === '/editor') {
    if (!hasEditorSignature()) return html(response, '<main>编辑器暂时不可用</main>');
    return html(
      response,
      `
      <input data-field="title"><textarea data-field="abstract"></textarea>
      <iframe id="ueditor_0" srcdoc="&lt;body contenteditable='true'&gt;&lt;/body&gt;"></iframe>
      <button type="button" data-testid="cover-trigger">选择封面</button>
      <div role="dialog" data-testid="cover-dialog" style="display:none">
        本地上传<input type="file" name="media" accept="image/*">
        <button type="button" data-testid="cover-confirm" data-ready="false">确定</button>
      </div>
      <div data-testid="cover-preview" style="display:none">封面已就绪</div>
      <button type="button" data-function="insertimage">插入正文图片</button>
      <div role="dialog" data-testid="body-image-dialog" style="display:none">
        本地图片
        <input type="file" data-testid="body-image-picker" name="media" accept="image/*" multiple>
        <p data-testid="body-upload-status" style="display:none"><span>拖动可调整顺序</span></p>
        <button type="button" data-testid="body-image-confirm" data-ready="false">确认</button>
      </div>
      <input data-field="tags"><input data-field="fingerprint">
      <select data-field="category"><option value="news">news</option></select>
      <label data-testid="not-original"><input type="radio" name="original">非原创</label>
      <label><input type="checkbox" data-testid="ai-generated">采用AI生成内容</label>
      <button data-testid="submit">发布</button>
      <script>
        document.querySelector('[data-testid=cover-trigger]').onclick=()=>document.querySelector('[data-testid=cover-dialog]').style.display='block';
        const editorFrame=document.querySelector('#ueditor_0');
        const registerEditorInput=()=>{
          const editorBody=editorFrame.contentDocument.body;
          if(editorBody.dataset.listenerRegistered==='true') return;
          editorBody.dataset.listenerRegistered='true';
          editorBody.addEventListener('input',()=>{
            if(editorBody.innerText.endsWith('收尾。') && editorBody.innerText.includes('1. 第一步')) {
              editorBody.innerHTML='<p>用于百家号浏览器仿真验证的正文内容。</p><ol><li>第一步\\n2. 第二步</li></ol><p>&#8205;收尾。</p>';
            }
          });
        };
        editorFrame.addEventListener('load',registerEditorInput);
        registerEditorInput();
        document.querySelector('[name=media]').onchange=()=>{
          const picker=document.querySelector('[name=media]');
          setTimeout(()=>{
            const confirm=document.querySelector('[data-testid=cover-confirm]');
            confirm.dataset.ready='true';
            confirm.textContent='确定 ('+picker.files.length+')';
          },100);
        };
        document.querySelector('[data-testid=cover-confirm]').onclick=(event)=>{
          if(event.currentTarget.dataset.ready!=='true') return;
          document.querySelector('[data-testid=cover-dialog]').style.display='none';
          setTimeout(()=>document.querySelector('[data-testid=cover-preview]').style.display='block',300);
        };
        document.querySelector('[data-function=insertimage]').onclick=()=>document.querySelector('[data-testid=body-image-dialog]').style.display='block';
        document.querySelector('[data-testid=body-image-picker]').onchange=()=>{
          const picker=document.querySelector('[data-testid=body-image-picker]');
          setTimeout(()=>{
            const confirm=document.querySelector('[data-testid=body-image-confirm]');
            confirm.dataset.ready='true';
            const status=document.querySelector('[data-testid=body-upload-status]');
            status.prepend(picker.files.length+'张上传成功');
            status.style.display='block';
          },100);
        };
        document.querySelector('[data-testid=body-image-confirm]').onclick=(event)=>{
          if(event.currentTarget.dataset.ready!=='true') return;
          const picker=document.querySelector('[data-testid=body-image-picker]');
          for(let index=0;index<picker.files.length;index+=1){
            const image=document.querySelector('#ueditor_0').contentDocument.createElement('img');
            image.alt='正文配图';
            document.querySelector('#ueditor_0').contentDocument.body.append(image);
          }
          document.querySelector('[data-testid=body-image-dialog]').style.display='none';
        };
        document.querySelector('[data-testid=submit]').onclick=async()=>{
          await fetch('/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
            aiGenerated:document.querySelector('[data-testid=ai-generated]').checked,
            bodyInputRegistered:document.querySelector('#ueditor_0').contentDocument.body.innerText.length>0,
            bodyImagesUploaded:document.querySelector('#ueditor_0').contentDocument.body.querySelectorAll('img').length,
            coverUploaded:document.querySelector('[data-testid=cover-preview]').style.display==='block',
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
      saveSubmitted(JSON.parse(Buffer.concat(chunks).toString('utf8')) as SubmittedPublication);
      response.writeHead(204).end();
    });
    return;
  }
  if (request.url === '/manage') {
    if (manageStartsAtHome()) {
      return html(
        response,
        `
        <nav data-testid="authenticated-home">
          <button>发布作品</button>
          <button data-testid="content-management-entry">内容管理</button>
          <a data-testid="publication-list-entry" href="/manage-list" style="display:none">作品管理</a>
          <span>个人中心</span>
        </nav>
        <script>
          document.querySelector('[data-testid=content-management-entry]').onclick=()=>{
            document.querySelector('[data-testid=publication-list-entry]').style.display='inline';
          };
        </script>
      `,
      );
    }
    return contentList(response, readSubmitted(), readDuplicateRows(), hasManageSignature());
  }
  if (request.url === '/manage-list') {
    return contentList(response, readSubmitted(), readDuplicateRows(), hasManageSignature());
  }
  response.writeHead(404).end();
}

function contentList(
  response: ServerResponse,
  item: SubmittedPublication | null,
  duplicateRows: boolean,
  hasManageSignature: boolean,
): void {
  const row = item
    ? `<div data-publication-row data-title="${escapeHtml(item.title)}" data-content-fingerprint="${item.fingerprint}" data-submitted-at="${new Date().toISOString()}" data-external-id="simulator-145" data-status="processing"><a href="/article/id=simulator-145">${escapeHtml(item.title)}</a>审核中</div>`
    : '';
  html(
    response,
    `
      <div data-testid="account-menu" style="display:none">已登录</div>
      <div ${hasManageSignature ? 'data-testid="content-list"' : ''}>
        ${row}${duplicateRows ? row.replaceAll('simulator-145', 'simulator-146') : ''}
      </div>
      <script>if(localStorage.getItem('simulator-auth')==='yes') document.querySelector('[data-testid=account-menu]').style.display='block'</script>
    `,
  );
}

function html(response: ServerResponse, body: string): void {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><html><body>${body}</body></html>`);
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
}
