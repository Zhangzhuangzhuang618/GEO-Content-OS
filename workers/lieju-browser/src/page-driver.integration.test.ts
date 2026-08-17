import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LiejuBrowserConfig } from './config.js';
import { PlaywrightLiejuPageDriver } from './page-driver.js';

interface SubmittedPublication {
  readonly address: string;
  readonly body: string;
  readonly category: string;
  readonly contactName: string;
  readonly imageCount: number;
  readonly mobilePhone: string;
  readonly title: string;
  readonly zone: string;
}

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000151';
const BODY = `${'企业搬迁前应核对装卸条件、车辆通行时间、物品数量和现场负责人，并把易损物品单独登记。'.repeat(12)}\n\n${'运输当天按清单逐项交接，保留车辆、包装和签收记录，出现异常时依据合同约定处理。'.repeat(12)}`;
const POSTING_PROFILE = Object.freeze({
  address: '广州市天河区测试路1号',
  category_id: '1' as const,
  contact_name: '测试联系人',
  mobile_phone: '13800138000',
  qq: '',
  street_id: null,
  wechat: '',
  zone_id: '73' as const,
});

describe('Lieju local browser simulator', () => {
  let baseUrl = '';
  let captchaRequired = false;
  let duplicateRows = false;
  let publicPageAvailable = false;
  let profileRoot = '';
  let server: ReturnType<typeof createServer>;
  let submitted: SubmittedPublication | null = null;

  beforeEach(async () => {
    captchaRequired = false;
    duplicateRows = false;
    publicPageAvailable = false;
    submitted = null;
    profileRoot = await mkdtemp(join(tmpdir(), 'geo-lieju-e2e-'));
    server = createServer((request, response) =>
      route(
        request,
        response,
        () => submitted,
        () => duplicateRows,
        () => captchaRequired,
        () => publicPageAvailable,
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

  it('logs in with QQ, fills the classified form, publishes once and reconciles', async () => {
    const driver = new PlaywrightLiejuPageDriver(config(baseUrl, profileRoot));
    const profilePath = join(profileRoot, ACCOUNT_ID);
    try {
      const login = await driver.startLogin(ACCOUNT_ID, profilePath);
      expect(login.qrPng.byteLength).toBeGreaterThan(0);
      expect(await driver.waitForAuthentication(ACCOUNT_ID, login.expiresAt)).toBe(true);
      const storageState = await driver.exportStorageState(ACCOUNT_ID);
      let preSubmitBytes = 0;
      const result = await driver.submit(
        {
          accountId: ACCOUNT_ID,
          contentFingerprint: 'a'.repeat(64),
          images: [
            {
              assetId: '00000000-0000-4000-8000-000000000152',
              body: Buffer.from('simulated-image'),
              mimeType: 'image/png',
              role: 'cover',
            },
          ],
          payload: payload('广州企业搬迁运输注意事项'),
          postingProfile: POSTING_PROFILE,
          profilePath,
          storageStateJson: storageState,
        },
        async (png) => {
          preSubmitBytes = png.byteLength;
        },
      );

      expect(preSubmitBytes).toBeGreaterThan(0);
      expect(submitted).toMatchObject({
        address: POSTING_PROFILE.address,
        category: POSTING_PROFILE.category_id,
        contactName: POSTING_PROFILE.contact_name,
        imageCount: 1,
        mobilePhone: POSTING_PROFILE.mobile_phone,
        title: '广州企业搬迁运输注意事项',
        zone: POSTING_PROFILE.zone_id,
      });
      expect(submitted?.body).toContain('企业搬迁前应核对');
      expect(result).toMatchObject({ externalId: '150', status: 'processing', url: null });
    } finally {
      await driver.close();
    }
  });

  it('logs in with an ephemeral Lieju username and password', async () => {
    const driver = new PlaywrightLiejuPageDriver(config(baseUrl, profileRoot));
    const accountId = '00000000-0000-4000-8000-000000000155';
    const profilePath = join(profileRoot, accountId);
    try {
      const login = await driver.startLogin(accountId, profilePath, {
        method: 'password',
        password: 'ephemeral-password',
        username: 'lieju-user',
      });
      expect(login.qrPng.byteLength).toBe(0);
      const storageState = await driver.exportStorageState(accountId);
      expect(storageState).not.toMatch(/lieju-user|ephemeral-password/u);
      expect(await driver.verifyAuthenticated(accountId, profilePath, storageState)).toBe(true);
    } finally {
      await driver.close();
    }
  });

  it('accepts a member-page login before opening the editor on another Lieju subdomain', async () => {
    const port = new URL(baseUrl).port;
    const crossHostConfig = Object.freeze({
      ...config(baseUrl, profileRoot),
      editorUrl: `http://post.lieju.localhost:${port}/5/73`,
      loginUrl: `http://www.lieju.localhost:${port}/signin`,
      manageUrl: `http://www.lieju.localhost:${port}/member/list.php`,
    });
    const driver = new PlaywrightLiejuPageDriver(crossHostConfig);
    const accountId = '00000000-0000-4000-8000-000000000157';
    try {
      const login = await driver.startLogin(accountId, join(profileRoot, accountId), {
        method: 'password',
        password: 'ephemeral-password',
        username: 'lieju-user',
      });
      expect(login.qrPng.byteLength).toBe(0);
      expect(
        await driver.verifyAuthenticated(
          accountId,
          join(profileRoot, accountId),
          await driver.exportStorageState(accountId),
        ),
      ).toBe(true);
    } finally {
      await driver.close();
    }
  });

  it('reports interactive CAPTCHA separately during password login', async () => {
    captchaRequired = true;
    const driver = new PlaywrightLiejuPageDriver(config(baseUrl, profileRoot));
    const accountId = '00000000-0000-4000-8000-000000000156';
    try {
      await expect(
        driver.startLogin(accountId, join(profileRoot, accountId), {
          method: 'password',
          password: 'ephemeral-password',
          username: 'lieju-user',
        }),
      ).rejects.toMatchObject({ code: 'CAPTCHA_REQUIRED' });
    } finally {
      await driver.close();
    }
  });

  it('stops before submission when Lieju requires Tencent CAPTCHA', async () => {
    captchaRequired = true;
    const driver = new PlaywrightLiejuPageDriver(config(baseUrl, profileRoot));
    const profilePath = join(profileRoot, ACCOUNT_ID);
    try {
      const login = await driver.startLogin(ACCOUNT_ID, profilePath);
      expect(await driver.waitForAuthentication(ACCOUNT_ID, login.expiresAt)).toBe(true);
      await expect(
        driver.submit(
          {
            accountId: ACCOUNT_ID,
            contentFingerprint: 'a'.repeat(64),
            images: [],
            payload: payload('广州物流发布验证码测试'),
            postingProfile: POSTING_PROFILE,
            profilePath,
            storageStateJson: await driver.exportStorageState(ACCOUNT_ID),
          },
          async () => undefined,
        ),
      ).rejects.toMatchObject({ code: 'CAPTCHA_REQUIRED' });
      expect(submitted).toBeNull();
    } finally {
      await driver.close();
    }
  });

  it('stops when the member list contains multiple matching publications', async () => {
    const driver = new PlaywrightLiejuPageDriver(config(baseUrl, profileRoot));
    const profilePath = join(profileRoot, ACCOUNT_ID);
    try {
      const login = await driver.startLogin(ACCOUNT_ID, profilePath);
      expect(await driver.waitForAuthentication(ACCOUNT_ID, login.expiresAt)).toBe(true);
      submitted = {
        address: POSTING_PROFILE.address,
        body: BODY,
        category: POSTING_PROFILE.category_id,
        contactName: POSTING_PROFILE.contact_name,
        imageCount: 0,
        mobilePhone: POSTING_PROFILE.mobile_phone,
        title: '重复匹配测试信息',
        zone: POSTING_PROFILE.zone_id,
      };
      duplicateRows = true;
      await expect(
        driver.reconcile(
          ACCOUNT_ID,
          profilePath,
          {
            contentFingerprint: 'a'.repeat(64),
            submittedAfter: new Date(Date.now() - 60_000),
            title: submitted.title,
          },
          await driver.exportStorageState(ACCOUNT_ID),
        ),
      ).rejects.toMatchObject({ code: 'MULTIPLE_MATCHES' });
    } finally {
      await driver.close();
    }
  });

  it('marks a publication published only after the public page contains the matching title', async () => {
    publicPageAvailable = true;
    submitted = {
      address: POSTING_PROFILE.address,
      body: BODY,
      category: POSTING_PROFILE.category_id,
      contactName: POSTING_PROFILE.contact_name,
      imageCount: 0,
      mobilePhone: POSTING_PROFILE.mobile_phone,
      title: '公开页面标题核验测试',
      zone: POSTING_PROFILE.zone_id,
    };
    const driver = new PlaywrightLiejuPageDriver(config(baseUrl, profileRoot));
    const profilePath = join(profileRoot, ACCOUNT_ID);
    try {
      const login = await driver.startLogin(ACCOUNT_ID, profilePath);
      expect(await driver.waitForAuthentication(ACCOUNT_ID, login.expiresAt)).toBe(true);
      await expect(
        driver.reconcile(
          ACCOUNT_ID,
          profilePath,
          {
            contentFingerprint: 'a'.repeat(64),
            submittedAfter: new Date(Date.now() - 60_000),
            title: submitted.title,
          },
          await driver.exportStorageState(ACCOUNT_ID),
        ),
      ).resolves.toMatchObject({
        externalId: '150',
        status: 'published',
        url: `${baseUrl}/info/150.html`,
      });
    } finally {
      await driver.close();
    }
  });
});

function payload(title: string) {
  return {
    body_text: BODY,
    citation_links: [],
    content_type: 'logistics_freight' as const,
    cover_asset_id: null,
    platform_code: 'lieju' as const,
    rule_version: 'lieju-render-rules@1.0.0' as const,
    schema_version: 'lieju-payload@1' as const,
    title,
  };
}

function config(baseUrl: string, profileRoot: string): LiejuBrowserConfig {
  return Object.freeze({
    databaseUrl: 'postgresql://unused',
    editorUrl: `${baseUrl}/5/73`,
    gatewayToken: 'x'.repeat(32),
    headless: true,
    healthPort: 9097,
    loginUrl: `${baseUrl}/signin`,
    manageUrl: `${baseUrl}/member/list.php`,
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
  readCaptchaRequired: () => boolean,
  readPublicPageAvailable: () => boolean,
  saveSubmitted: (value: SubmittedPublication) => void,
): void {
  if (request.url === '/qr.svg') {
    response.writeHead(200, { 'content-type': 'image/svg+xml' });
    response.end(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="white"/><rect x="20" y="20" width="160" height="160" fill="black"/></svg>',
    );
    return;
  }
  if (request.url === '/signin') {
    return html(
      response,
      `<img data-lieju-qq-qr src="/qr.svg"><script>setTimeout(()=>{document.cookie='lieju-auth=yes; path=/';location.href='/member/list.php'},1500)</script>`,
    );
  }
  if (request.url === '/login/') {
    const captcha = readCaptchaRequired() ? '<div id="TencentCaptcha">验证码</div>' : '';
    const cookieDomain = request.headers.host?.includes('.lieju.localhost')
      ? ' domain=lieju.localhost;'
      : '';
    return html(
      response,
      `<form><input name="username"><input name="password" type="password"><input name="cookietime" type="checkbox" checked><input id="login-submit" type="submit" value="登录"></form>
       ${captcha}<script>document.querySelector('form').onsubmit=(event)=>{event.preventDefault();${readCaptchaRequired() ? '' : `document.cookie='lieju-auth=yes;${cookieDomain} path=/';location.href='/member/list.php'`}}</script>`,
    );
  }
  if (request.url === '/5/73') {
    if (!authenticated(request)) return redirect(response, '/signin');
    return html(response, editor(readCaptchaRequired()));
  }
  if (request.method === 'POST' && request.url === '/publish') {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      saveSubmitted(JSON.parse(Buffer.concat(chunks).toString('utf8')) as SubmittedPublication);
      json(response, { success: true });
    });
    return;
  }
  if (request.url === '/member/list.php') {
    if (!authenticated(request)) return redirect(response, '/signin');
    const item = readSubmitted();
    const row = item
      ? `<tr><td><input type="checkbox" value="150"></td><td>${
          readPublicPageAvailable()
            ? `<a href="/info/150.html">${escapeHtml(item.title)}</a>`
            : escapeHtml(item.title)
        }</td><td>${readPublicPageAvailable() ? '已审核' : '待审核'}</td></tr>`
      : '';
    const duplicate = readDuplicateRows() ? row.replace('value="150"', 'value="151"') : '';
    return html(
      response,
      `<a href="/member/index.php">会员中心</a><a href="?action=quit">退出</a><table>${row}${duplicate}</table>`,
    );
  }
  if (request.url === '/info/150.html' && readPublicPageAvailable()) {
    const item = readSubmitted();
    return html(response, `<h1>${escapeHtml(item?.title ?? '')}</h1><p>公开分类信息正文</p>`);
  }
  response.writeHead(404).end();
}

function editor(captchaRequired: boolean): string {
  return `<a href="/member/index.php">会员中心</a><a href="?action=quit">退出</a>
    <select id="atc_zone_id"><option value="73">天河区</option></select>
    <input id="atc_title"><select id="atc_leibie"><option value="1">空调拆装</option></select>
    <input id="atc_dizhi"><textarea id="atc_content"></textarea><input id="in_url1" type="file">
    <div id="preview1"><img src=""></div><div id="previewerr1"></div>
    <input id="atc_mobphone"><input id="atc_oicq"><input id="atc_wechat"><input id="atc_linkman">
    <select id="atc_autofill"><option value="0">不自动填充</option></select><input id="dtop" type="checkbox">
    <input id="atc_yzm" value="${captchaRequired ? '' : '1'}">${captchaRequired ? '<div id="TencentCaptcha">验证码</div>' : ''}
    <button id="sub" type="button">提交发布</button><div id="result"></div>
    <script>
      document.querySelector('#in_url1').onchange=()=>{
        const input=document.querySelector('#in_url1');
        const file=input.files[0];
        const reader=new FileReader();
        reader.onload=()=>{document.querySelector('#preview1 img').src=reader.result;input.dataset.uploaded='1';input.value=''};
        reader.readAsDataURL(file);
      };
      document.querySelector('#sub').onclick=async()=>{
        const image=document.querySelector('#in_url1');
        const result=await fetch('/publish',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
          address:document.querySelector('#atc_dizhi').value,
          body:document.querySelector('#atc_content').value,
          category:document.querySelector('#atc_leibie').value,
          contactName:document.querySelector('#atc_linkman').value,
          imageCount:image.dataset.uploaded==='1'?1:0,
          mobilePhone:document.querySelector('#atc_mobphone').value,
          title:document.querySelector('#atc_title').value,
          zone:document.querySelector('#atc_zone_id').value
        })});
        if(result.ok) document.querySelector('#result').textContent='提交成功，待审核';
      };
    </script>`;
}

function authenticated(request: IncomingMessage): boolean {
  return request.headers.cookie?.includes('lieju-auth=yes') === true;
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
