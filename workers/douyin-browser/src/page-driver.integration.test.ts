import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DouyinBrowserConfig } from './config.js';
import { PlaywrightDouyinPageDriver } from './page-driver.js';

interface SubmittedPublication {
  readonly aiDeclared: boolean;
  readonly description: string;
  readonly fileNames: readonly string[];
  readonly fingerprint: string;
  readonly originalDeclared: boolean;
  readonly submittedAt: string;
  readonly title: string;
}

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000158';
const CONTENT_FINGERPRINT = 'a'.repeat(64);
const IMAGE_IDS = Array.from(
  { length: 5 },
  (_, index) => `00000000-0000-4000-8000-${String(170 + index).padStart(12, '0')}`,
);
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

describe('Douyin local browser simulator', () => {
  let baseUrl = '';
  let duplicateRows = false;
  let insertEditorZeroWidthSeparators = false;
  let postSubmitChallenge = false;
  let profileRoot = '';
  let realisticRows = false;
  let server: ReturnType<typeof createServer>;
  let submitted: SubmittedPublication | null = null;

  beforeEach(async () => {
    duplicateRows = false;
    insertEditorZeroWidthSeparators = false;
    postSubmitChallenge = false;
    realisticRows = false;
    submitted = null;
    profileRoot = await mkdtemp(join(tmpdir(), 'geo-douyin-e2e-'));
    server = createServer((request, response) => {
      void route(
        request,
        response,
        () => submitted,
        () => duplicateRows,
        () => insertEditorZeroWidthSeparators,
        () => postSubmitChallenge,
        () => realisticRows,
        (value) => {
          submitted = value;
        },
      ).catch((error) => {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(error instanceof Error ? error.message : 'simulator failure');
      });
    });
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

  it('logs in, uploads ordered cards, declares AI, submits once and reconciles', async () => {
    const driver = new PlaywrightDouyinPageDriver(config(baseUrl, profileRoot));
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
          contentFingerprint: CONTENT_FINGERPRINT,
          images: IMAGE_IDS.map((assetId) => ({
            assetId,
            body: PNG,
            mimeType: 'image/png' as const,
          })),
          payload: payload(),
          profilePath,
          storageStateJson: storageState,
        },
        async (png) => {
          preSubmitBytes = png.byteLength;
        },
      );

      expect(preSubmitBytes).toBeGreaterThan(0);
      expect(submitted).toMatchObject({
        aiDeclared: true,
        description: '搬家前核对服务范围、报价边界和验收方式。\n\n#搬家准备 #广州搬家',
        fingerprint: CONTENT_FINGERPRINT,
        originalDeclared: false,
        title: '搬家前先看这五项',
      });
      expect(submitted?.fileNames).toEqual(
        IMAGE_IDS.map((assetId, index) => `${String(index + 1).padStart(2, '0')}-${assetId}.png`),
      );
      expect(result).toMatchObject({
        externalId: CONTENT_FINGERPRINT,
        status: 'processing',
        url: `${baseUrl}/content/123456?status=review`,
      });
      await expect(
        driver.reconcile(
          ACCOUNT_ID,
          profilePath,
          {
            contentFingerprint: CONTENT_FINGERPRINT,
            submittedAfter: new Date(Date.now() - 60_000),
            title: '搬家前先看这五项',
          },
          storageState,
        ),
      ).resolves.toMatchObject({
        externalId: '123456',
        status: 'processing',
        url: `${baseUrl}/note/123456`,
      });
    } finally {
      await driver.close();
    }
  });

  it('stops when two current rows match the exact title and fingerprint', async () => {
    submitted = {
      aiDeclared: true,
      description: '测试说明',
      fileNames: [],
      fingerprint: CONTENT_FINGERPRINT,
      originalDeclared: false,
      submittedAt: new Date().toISOString(),
      title: '重复匹配图文',
    };
    duplicateRows = true;
    const driver = new PlaywrightDouyinPageDriver(config(baseUrl, profileRoot));
    const profilePath = join(profileRoot, ACCOUNT_ID);
    try {
      const login = await driver.startLogin(ACCOUNT_ID, profilePath);
      expect(await driver.waitForAuthentication(ACCOUNT_ID, login.expiresAt)).toBe(true);
      await expect(
        driver.reconcile(
          ACCOUNT_ID,
          profilePath,
          {
            contentFingerprint: CONTENT_FINGERPRINT,
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

  it('accepts zero-width separators inserted by the editor before submit verification', async () => {
    insertEditorZeroWidthSeparators = true;
    const driver = new PlaywrightDouyinPageDriver(config(baseUrl, profileRoot));
    const profilePath = join(profileRoot, ACCOUNT_ID);
    try {
      const login = await driver.startLogin(ACCOUNT_ID, profilePath);
      expect(await driver.waitForAuthentication(ACCOUNT_ID, login.expiresAt)).toBe(true);
      await expect(
        driver.submit(
          {
            accountId: ACCOUNT_ID,
            contentFingerprint: CONTENT_FINGERPRINT,
            images: IMAGE_IDS.map((assetId) => ({
              assetId,
              body: PNG,
              mimeType: 'image/png' as const,
            })),
            payload: payload(),
            profilePath,
            storageStateJson: await driver.exportStorageState(ACCOUNT_ID),
          },
          async () => undefined,
        ),
      ).resolves.toMatchObject({ status: 'processing' });
      expect(submitted?.description).toContain('\u200B');
    } finally {
      await driver.close();
    }
  });

  it('stops immediately when publication opens the real SMS verification dialog', async () => {
    postSubmitChallenge = true;
    const driver = new PlaywrightDouyinPageDriver(config(baseUrl, profileRoot));
    const profilePath = join(profileRoot, ACCOUNT_ID);
    try {
      const login = await driver.startLogin(ACCOUNT_ID, profilePath);
      expect(await driver.waitForAuthentication(ACCOUNT_ID, login.expiresAt)).toBe(true);
      await expect(
        driver.submit(
          {
            accountId: ACCOUNT_ID,
            contentFingerprint: CONTENT_FINGERPRINT,
            images: IMAGE_IDS.map((assetId) => ({
              assetId,
              body: PNG,
              mimeType: 'image/png' as const,
            })),
            payload: payload(),
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

  it('reconciles the current creator list markup to a canonical public note URL', async () => {
    submitted = {
      aiDeclared: true,
      description: '测试说明',
      fileNames: [],
      fingerprint: CONTENT_FINGERPRINT,
      originalDeclared: false,
      submittedAt: new Date().toISOString(),
      title: '跨区搬家当天怎么排车辆和电梯',
    };
    realisticRows = true;
    const driver = new PlaywrightDouyinPageDriver(config(baseUrl, profileRoot));
    const profilePath = join(profileRoot, ACCOUNT_ID);
    try {
      const login = await driver.startLogin(ACCOUNT_ID, profilePath);
      expect(await driver.waitForAuthentication(ACCOUNT_ID, login.expiresAt)).toBe(true);
      const startedAt = Date.now();
      const reconciled = await driver.reconcile(
        ACCOUNT_ID,
        profilePath,
        {
          contentFingerprint: CONTENT_FINGERPRINT,
          submittedAfter: new Date(Date.now() - 60_000),
          title: submitted.title,
        },
        await driver.exportStorageState(ACCOUNT_ID),
      );
      expect(reconciled).toEqual({
        externalId: '7678487251839470902',
        reviewReason: null,
        status: 'published',
        url: 'https://www.douyin.com/note/7678487251839470902',
      });
      expect(Date.now() - startedAt).toBeLessThan(4_000);
    } finally {
      await driver.close();
    }
  });

  it('waits for the delayed empty content-management state', async () => {
    const driver = new PlaywrightDouyinPageDriver(config(baseUrl, profileRoot));
    const profilePath = join(profileRoot, ACCOUNT_ID);
    try {
      const login = await driver.startLogin(ACCOUNT_ID, profilePath);
      expect(await driver.waitForAuthentication(ACCOUNT_ID, login.expiresAt)).toBe(true);
      await expect(
        driver.reconcile(
          ACCOUNT_ID,
          profilePath,
          {
            contentFingerprint: CONTENT_FINGERPRINT,
            submittedAfter: new Date(Date.now() - 60_000),
            title: '尚未发布的图文',
          },
          await driver.exportStorageState(ACCOUNT_ID),
        ),
      ).resolves.toBeNull();
    } finally {
      await driver.close();
    }
  });

  it('surfaces the SMS identity challenge instead of waiting for the QR to expire', async () => {
    const driver = new PlaywrightDouyinPageDriver(
      Object.freeze({ ...config(baseUrl, profileRoot), loginUrl: `${baseUrl}/login?sms=1` }),
    );
    try {
      const login = await driver.startLogin(ACCOUNT_ID, join(profileRoot, ACCOUNT_ID));
      await expect(driver.waitForAuthentication(ACCOUNT_ID, login.expiresAt)).rejects.toMatchObject(
        {
          code: 'CAPTCHA_REQUIRED',
        },
      );
      const diagnostic = await driver.inspectLoginVerification(ACCOUNT_ID);
      expect(diagnostic).toMatchObject({
        availableMethods: ['sms_code', 'original_device_scan'],
        challengeType: 'identity_choice',
        hasCodeInput: false,
        pagePath: '/login',
      });
      expect(diagnostic?.screenshotPng.byteLength).toBeGreaterThan(0);

      await expect(
        driver.submitLoginVerification(ACCOUNT_ID, { method: 'verification_sms_send' }),
      ).resolves.toMatchObject({
        challengeType: 'sms_code',
        hasCodeInput: true,
        maskedMobile: '138****5678',
        smsResendAvailable: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await expect(
        driver.submitLoginVerification(ACCOUNT_ID, { method: 'verification_sms_send' }),
      ).resolves.toMatchObject({
        challengeType: 'sms_code',
        hasCodeInput: true,
        maskedMobile: '138****5678',
        smsResendAvailable: false,
      });
      await expect(
        driver.submitLoginVerification(ACCOUNT_ID, {
          method: 'verification_sms_verify',
          sms_code: '654321',
        }),
      ).resolves.toBeNull();
      const storageState = await driver.exportStorageState(ACCOUNT_ID);
      expect(storageState).toContain('douyin-auth');
      expect(storageState).not.toContain('654321');
    } finally {
      await driver.close();
    }
  });

  it('does not report an SMS control covered by a verification mask as resendable', async () => {
    const driver = new PlaywrightDouyinPageDriver(
      Object.freeze({
        ...config(baseUrl, profileRoot),
        loginUrl: `${baseUrl}/login?sms=blocked`,
        navigationTimeoutMs: 500,
      }),
    );
    try {
      const login = await driver.startLogin(ACCOUNT_ID, join(profileRoot, `${ACCOUNT_ID}-blocked`));
      await expect(driver.waitForAuthentication(ACCOUNT_ID, login.expiresAt)).rejects.toMatchObject(
        { code: 'CAPTCHA_REQUIRED' },
      );
      await expect(
        driver.submitLoginVerification(ACCOUNT_ID, { method: 'verification_sms_send' }),
      ).rejects.toMatchObject({ code: 'CAPTCHA_REQUIRED' });
      await expect(driver.inspectLoginVerification(ACCOUNT_ID)).resolves.toMatchObject({
        challengeType: 'sms_code',
        hasCodeInput: true,
        smsResendAvailable: false,
      });
    } finally {
      await driver.close();
    }
  });

  it('returns a scannable original-device verification QR without exposing it in diagnostics', async () => {
    const driver = new PlaywrightDouyinPageDriver(
      Object.freeze({ ...config(baseUrl, profileRoot), loginUrl: `${baseUrl}/login?sms=1` }),
    );
    try {
      const login = await driver.startLogin(ACCOUNT_ID, join(profileRoot, `${ACCOUNT_ID}-device`));
      await expect(driver.waitForAuthentication(ACCOUNT_ID, login.expiresAt)).rejects.toMatchObject(
        {
          code: 'CAPTCHA_REQUIRED',
        },
      );
      const diagnostic = await driver.submitLoginVerification(ACCOUNT_ID, {
        method: 'verification_device_qr',
      });
      expect(diagnostic).toMatchObject({ challengeType: 'original_device_scan' });
      expect(diagnostic?.qrPng?.byteLength).toBeGreaterThan(0);
      expect(diagnostic?.screenshotPng.byteLength).toBeGreaterThan(0);
    } finally {
      await driver.close();
    }
  });
});

function payload() {
  return {
    ai_generated: true as const,
    cards: IMAGE_IDS.map((_, index) => ({
      body: `第${index + 1}页内容`,
      card_key: `card-${index + 1}`,
      heading: `第${index + 1}项`,
      kind:
        index === 0 ? ('cover' as const) : index === 4 ? ('summary' as const) : ('body' as const),
    })),
    citation_links: [],
    content_kind: 'image_note' as const,
    description: '搬家前核对服务范围、报价边界和验收方式。',
    image_asset_ids: IMAGE_IDS,
    platform_code: 'douyin' as const,
    rule_version: 'douyin-render-rules@1.0.0' as const,
    schema_version: 'douyin-image-note-payload@1' as const,
    title: '搬家前先看这五项',
    topics: ['搬家准备', '广州搬家'],
  };
}

function config(base: string, root: string): DouyinBrowserConfig {
  return Object.freeze({
    databaseUrl: 'postgresql://unused',
    editorUrl: `${base}/content/upload`,
    gatewayToken: 'x'.repeat(32),
    headless: true,
    healthPort: 9098,
    loginUrl: `${base}/login`,
    manageUrl: `${base}/content/manage`,
    navigationTimeoutMs: 5_000,
    profileRoot: root,
    simulator: true,
  });
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  readSubmitted: () => SubmittedPublication | null,
  readDuplicateRows: () => boolean,
  readInsertEditorZeroWidthSeparators: () => boolean,
  readPostSubmitChallenge: () => boolean,
  readRealisticRows: () => boolean,
  saveSubmitted: (value: SubmittedPublication) => void,
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
  if (url.pathname === '/qrcode.svg') {
    response.writeHead(200, { 'content-type': 'image/svg+xml' });
    response.end(
      '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" fill="white"/><rect x="20" y="20" width="200" height="200" fill="black"/></svg>',
    );
    return;
  }
  if (url.pathname === '/login') {
    const smsBlocked = url.searchParams.get('sms') === 'blocked';
    const loginScript = url.searchParams.has('sms')
      ? `setTimeout(()=>{
           document.body.insertAdjacentHTML('beforeend','<div class="user-info">发布作品 作品管理</div><section id="security-challenge"><h2>身份验证</h2><p>接收短信验证码</p><button id="sms-method">发送短信验证</button><button id="device-method">使用原设备扫码</button></section>');
           document.querySelector('#sms-method').onclick=()=>{
             document.querySelector('#security-challenge').innerHTML='<h2>接收短信验证码</h2><input placeholder="短信验证码" autocomplete="one-time-code"><button id="send-code">获取验证码</button>${smsBlocked ? '<div id="uc-second-verify"><div class="second_verify_mask" style="position:fixed;inset:0;z-index:10"></div></div>' : ''}';
             document.querySelector('#send-code').onclick=()=>{
               const send=document.querySelector('#send-code');
               send.disabled=true;send.textContent='60秒后重新发送';
               if(!document.querySelector('.mobile-value'))document.querySelector('#security-challenge').insertAdjacentHTML('beforeend','<p class="mobile-value">138****5678</p><button id="verify-code">验证</button>');
               document.querySelector('#verify-code').onclick=()=>{
                 if(document.querySelector('input').value!=='654321')return;
                 document.cookie='douyin-auth=yes; path=/';history.replaceState(null,'','/creator');document.body.innerHTML='<div class="user-info">发布作品 作品管理</div>';
               };
               setTimeout(()=>{send.disabled=false;send.textContent='重新发送验证码'},1000);
             };
           };
           document.querySelector('#device-method').onclick=()=>{
             document.querySelector('#security-challenge').innerHTML='<h2>使用原设备扫码</h2><img class="verification-qr" aria-label="二次验证二维码" src="/qrcode.svg">';
           };
         },200)`
      : `setTimeout(()=>history.replaceState(null,'','/login?qr_refresh=1'),200);
         setTimeout(()=>{document.cookie='douyin-auth=yes; path=/';history.replaceState(null,'','/creator');document.body.innerHTML='<div class="user-info">发布作品 作品管理</div>'},1200)`;
    return html(
      response,
      `<div id="douyin_login_landing_flat_container">
         <div id="douyin_login_comp_scan_code">
           <img aria-label="二维码" src="/qrcode.svg"><div id="state">扫码登录</div>
         </div>
       </div>
       <canvas id="decorative-animation"></canvas>
       <script>${loginScript}</script>`,
    );
  }
  if (url.pathname === '/content/upload') {
    if (!authenticated(request)) return redirect(response, '/login');
    return redirect(response, '/content/post/image?enter_from=publish_page&type=new');
  }
  if (url.pathname === '/content/post/image') {
    if (!authenticated(request)) return redirect(response, '/login');
    return html(
      response,
      `<div id="authenticated-markers" style="display:none">作品发布 内容管理</div>
       <div aria-hidden="true" style="position:absolute;left:-10000px">身份验证 发送短信验证</div>
       <nav id="mode-tabs"><div>发布视频</div></nav>
       <section id="video-editor"><input type="file" accept="video/*"></section>
       <section id="image-note-editor" style="display:none">
         <input id="images" type="file" accept="image/jpeg,image/png,image/webp" multiple>
         <div id="upload-count"></div>
         <input id="title" placeholder="作品标题">
         <textarea id="description" placeholder="作品描述"></textarea>
         <div id="declaration-row"><span>自主声明</span><button id="declaration-trigger" type="button">请选择自主声明</button></div>
         <div id="declaration-dialog" role="dialog" style="display:none">
           <div id="aigc-option" role="radio" aria-checked="false" aria-label="内容由AI生成"><span id="aigc-option-label">内容由AI生成</span></div>
           <button id="declaration-confirm" type="button" disabled>确定</button>
         </div>
         <label>原创内容<input id="original" type="checkbox" checked></label>
         <button id="publish" type="button">发布</button>
       </section>
       <script>
         const images=document.querySelector('#images');
         setTimeout(()=>{document.querySelector('#authenticated-markers').style.display='block'},300);
         setTimeout(()=>{
           const tab=document.createElement('div');tab.id='image-note-tab';tab.textContent='发布图文';
           tab.onclick=()=>{
             document.querySelector('#video-editor').style.display='none';
             document.querySelector('#image-note-editor').style.display='block';
           };
           document.querySelector('#mode-tabs').append(tab);
         },600);
         images.onchange=()=>{
           document.querySelector('#upload-count').textContent='已添加'+images.files.length+'张图片';
         };
         document.querySelector('#description').addEventListener('input',(event)=>{
           if(!${JSON.stringify(readInsertEditorZeroWidthSeparators())})return;
           const field=event.currentTarget;
           field.value=field.value.replaceAll('\\n','\\u200B\\n');
         });
         const declarationDialog=document.querySelector('#declaration-dialog');
         const declarationTrigger=document.querySelector('#declaration-trigger');
         declarationTrigger.onclick=()=>{declarationDialog.style.display='block'};
         const aigcOption=document.querySelector('#aigc-option');
         aigcOption.onclick=()=>{
           aigcOption.setAttribute('aria-checked','true');
           document.querySelector('#declaration-confirm').disabled=false;
           declarationTrigger.textContent='内容由AI生成';
         };
         document.querySelector('#aigc-option-label').onclick=(event)=>event.stopPropagation();
         document.querySelector('#declaration-confirm').onclick=()=>{
           if(aigcOption.getAttribute('aria-checked')!=='true')return;
           declarationDialog.style.display='none';
           document.querySelector('#title').removeAttribute('placeholder');
           document.querySelector('#description').removeAttribute('placeholder');
         };
         document.querySelector('#publish').onclick=async()=>{
           const publishing=document.createElement('p');
           publishing.id='publishing';publishing.textContent='正在发布';
           document.body.append(publishing);
           if(${JSON.stringify(readPostSubmitChallenge())}){
             await new Promise((resolve)=>setTimeout(resolve,200));
             const challenge=document.createElement('section');
             challenge.innerHTML='<h2>接收短信验证码</h2><button>获取验证码</button><button>使用原设备扫码</button>';
             document.body.append(challenge);
             return;
           }
           await new Promise((resolve)=>setTimeout(resolve,700));
           const result=await fetch('/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
             aiDeclared:aigcOption.getAttribute('aria-checked')==='true',
             description:document.querySelector('#description').value,
             fileNames:Array.from(images.files).map((file)=>file.name),
             originalDeclared:document.querySelector('#original').checked,
             title:document.querySelector('#title').value
           })});
           if(result.ok) location.href='/content/123456?status=review';
         };
       </script>`,
    );
  }
  if (url.pathname === '/submit' && request.method === 'POST') {
    const value = JSON.parse(await body(request)) as Omit<
      SubmittedPublication,
      'fingerprint' | 'submittedAt'
    >;
    saveSubmitted({
      ...value,
      fingerprint: CONTENT_FINGERPRINT,
      submittedAt: new Date().toISOString(),
    });
    response.writeHead(204);
    response.end();
    return;
  }
  if (url.pathname === '/content/123456') {
    return html(response, '<div class="user-info">发布作品 作品管理</div><p>提交成功，审核中</p>');
  }
  if (url.pathname === '/janus/douyin/creator/pc/work_list') {
    const current = readSubmitted();
    return json(response, {
      aweme_list: current
        ? [
            {
              aweme_id: '7678487251839470902',
              create_time: Math.floor(new Date(current.submittedAt).getTime() / 1_000),
              desc: `${current.title}。${current.description}`,
              share_url: 'https://www.iesdouyin.com/share/note/7678487251839470902/',
            },
          ]
        : [],
    });
  }
  if (url.pathname === '/content/manage') {
    if (!authenticated(request)) return redirect(response, '/login');
    const current = readSubmitted();
    const rows = current
      ? readRealisticRows()
        ? realisticPublicationRow(current, '7678487251839470902')
        : [
            publicationRow(current, '123456'),
            publicationRow(
              { ...current, submittedAt: new Date(Date.now() - 86_400_000).toISOString() },
              '111111',
            ),
            ...(readDuplicateRows() ? [publicationRow(current, '654321')] : []),
          ].join('')
      : '';
    const loaded = `<div>作品发布 内容管理</div>${rows || '<p>没有更多作品</p>'}`;
    const waitForList = readRealisticRows()
      ? "fetch('/janus/douyin/creator/pc/work_list?status=0&count=20')"
      : 'Promise.resolve()';
    return html(
      response,
      `<main id="manage-root"><p>加载中</p></main>
       <script>setTimeout(async()=>{await ${waitForList};document.querySelector('#manage-root').innerHTML=${JSON.stringify(loaded)}},700)</script>`,
    );
  }
  response.writeHead(404);
  response.end('not found');
}

function publicationRow(value: SubmittedPublication, externalId: string): string {
  return `<article class="content-item" data-title="${escapeHtml(value.title)}" data-content-fingerprint="${value.fingerprint}" data-submitted-at="${value.submittedAt}" data-external-id="${externalId}"><a class="work-title" href="/note/${externalId}">${escapeHtml(value.title)}</a><span>审核中</span></article>`;
}

function realisticPublicationRow(value: SubmittedPublication, externalId: string): string {
  void externalId;
  const submittedAt = new Date(value.submittedAt);
  const timestamp = `${submittedAt.getFullYear()}年${String(submittedAt.getMonth() + 1).padStart(2, '0')}月${String(submittedAt.getDate()).padStart(2, '0')}日 ${String(submittedAt.getHours()).padStart(2, '0')}:${String(submittedAt.getMinutes()).padStart(2, '0')}`;
  return `<div class="video-card-production"><div class="video-card-info"><div class="info-title-text">${escapeHtml(value.title)}。${escapeHtml(value.description)}</div></div><span>${timestamp}</span><span>已发布</span></div>`;
}

function authenticated(request: IncomingMessage): boolean {
  return request.headers.cookie?.includes('douyin-auth=yes') ?? false;
}

function html(response: ServerResponse, value: string): void {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><html><body>${value}</body></html>`);
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { location });
  response.end();
}

function body(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
