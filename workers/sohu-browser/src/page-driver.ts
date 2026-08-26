import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import type { SohuBrowserLoginRequest } from '@geo-content-os/contracts';

import type { SohuBrowserConfig } from './config.js';
import type {
  DriverPublishInput,
  LoginStartResult,
  RemotePublication,
  SohuPageDriver,
} from './types.js';

const SELECTORS = Object.freeze({
  abstract: '.abstract-main textarea, textarea[placeholder="请输入摘要"]',
  authenticated: '.user-info, .user-name, [class*="account-info"]',
  body: '.ql-editor[contenteditable="true"], #editor .ql-editor',
  captcha: 'iframe[src*="captcha"], [class*="captcha"], text=/验证码|安全验证/u',
  declarationAi:
    '#info-source-signature label:has(input[type="radio"][value="2"]), label:has-text("含有AI生成内容"), label:has-text("包含AI创作内容")',
  loginAccount: '[data-role="login-btn"], .login-sohu, button:has-text("登录")',
  loginPassword: '[data-role="user-secret"]',
  loginUsername: '[data-role="user-passport"]',
  managePublish: 'button:has-text("发布内容")',
  publish:
    'li.publish-report-btn.active, button:has-text("发布"), .submit-btn button, [class*="submit-btn"] button',
  qr: 'img.qrcode, img[src*="qrcode"], img[src*="qr"], canvas',
  smsCaptcha: '[data-role="mobilenum-captcha"] .captcha-pic',
  smsCaptchaInput: '[data-role="mobilenum-tip"]',
  smsCode: '[data-role="mobilenum-dynamic"]',
  smsGetCode: '[data-role="dynamic-get"]',
  smsMobile: '[data-role="mobilenum"]',
  title: 'input[placeholder="请输入标题（5-72字）"]',
  wechatLogin: '[data-login="weChat"], .wx-icon',
});

export class PageDriverError extends Error {
  public constructor(
    public readonly code:
      | 'AUTH_REQUIRED'
      | 'ACCOUNT_PERMISSION_REQUIRED'
      | 'CAPTCHA_REQUIRED'
      | 'MULTIPLE_MATCHES'
      | 'PAGE_SIGNATURE_CHANGED'
      | 'PUBLISH_STATE_UNKNOWN',
    message: string,
  ) {
    super(message);
    this.name = 'PageDriverError';
  }
}

type PublishOperationStage =
  | 'capture_pre_submit'
  | 'fill_abstract'
  | 'fill_body'
  | 'fill_title'
  | 'load_editor'
  | 'persist_pre_submit'
  | 'submit'
  | 'upload_body_images'
  | 'upload_cover'
  | 'upload_images'
  | 'verify_editor'
  | 'verify_pre_submit';

export class PageDriverOperationError extends Error {
  public constructor(
    public readonly stage: PublishOperationStage,
    cause: unknown,
  ) {
    super('Sohu browser operation failed', { cause });
    this.name = 'PageDriverOperationError';
  }
}

export class PlaywrightSohuPageDriver implements SohuPageDriver {
  private readonly contexts = new Map<string, BrowserContext>();
  private readonly pages = new Map<string, Page>();

  public constructor(private readonly config: SohuBrowserConfig) {}

  public async startLogin(
    accountId: string,
    profilePath: string,
    input: SohuBrowserLoginRequest = { method: 'wechat' },
  ): Promise<LoginStartResult> {
    const page = await this.page(accountId, profilePath, null);
    const expiresAt = new Date(Date.now() + 180_000);
    if (input.method === 'sms_send') return this.sendSmsCode(page, expiresAt, input);
    if (input.method === 'sms_verify') {
      return this.verifySmsCode(accountId, page, expiresAt, input);
    }
    await this.openLogin(page);
    if (await this.isAuthenticated(page)) return { expiresAt, qrPng: Buffer.alloc(0) };
    if (input.method === 'password') {
      await page.locator(SELECTORS.loginUsername).fill(input.account);
      await page.locator(SELECTORS.loginPassword).fill(input.password);
      await this.acceptProtocol(page);
      await page.locator('[data-role="submit-user"]').click();
      const authenticated = await this.waitForAuthentication(
        accountId,
        new Date(Date.now() + this.config.navigationTimeoutMs),
      );
      if (!authenticated) {
        await page
          .locator(SELECTORS.loginPassword)
          .fill('')
          .catch(() => undefined);
        if (
          await page
            .locator('[data-role="user-captcha"]')
            .isVisible()
            .catch(() => false)
        ) {
          throw new PageDriverError('CAPTCHA_REQUIRED', 'Sohu requires an account login CAPTCHA');
        }
        throw new PageDriverError('AUTH_REQUIRED', 'Sohu rejected the account or password');
      }
      return { expiresAt, qrPng: Buffer.alloc(0) };
    }
    if (input.method === 'sms_prepare') {
      await page
        .getByText('手机登录', { exact: true })
        .click()
        .catch(() => undefined);
      await page.locator(SELECTORS.smsMobile).fill(input.mobile);
      const captcha = page.locator(SELECTORS.smsCaptcha).first();
      await captcha.waitFor({ state: 'visible', timeout: this.config.navigationTimeoutMs });
      return Object.freeze({
        captchaPng: await captcha.screenshot({ type: 'png' }),
        expiresAt,
        qrPng: Buffer.alloc(0),
      });
    }
    const wechat = page.locator(SELECTORS.wechatLogin).first();
    await wechat.waitFor({ state: 'visible', timeout: this.config.navigationTimeoutMs });
    await wechat.click();
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    await this.rejectOAuthFailure(page);
    const qr = page.locator(SELECTORS.qr).first();
    await qr.waitFor({ state: 'visible', timeout: this.config.navigationTimeoutMs });
    await page.waitForTimeout(1_000);
    return Object.freeze({ expiresAt, qrPng: await qr.screenshot({ type: 'png' }) });
  }

  private async openLogin(page: Page): Promise<void> {
    await page.goto(this.config.loginUrl, { waitUntil: 'domcontentloaded' });
    await this.rejectCaptcha(page);
    const accountLogin = page.locator(SELECTORS.loginAccount).first();
    if (await accountLogin.isVisible().catch(() => false)) await accountLogin.click();
  }

  private async acceptProtocol(page: Page): Promise<void> {
    const protocol = page.locator('[data-role="radio-protocol"]').first();
    const className = (await protocol.getAttribute('class')) ?? '';
    if (!/(?:^|\s)(?:active|checked|selected|radio-icon-sel)(?=\s|$)/u.test(className)) {
      await protocol.click();
    }
  }

  private async sendSmsCode(
    page: Page,
    expiresAt: Date,
    input: Extract<SohuBrowserLoginRequest, { method: 'sms_send' }>,
  ): Promise<LoginStartResult> {
    const mobile = page.locator(SELECTORS.smsMobile);
    if (!(await mobile.isVisible().catch(() => false))) {
      throw new PageDriverError('AUTH_REQUIRED', 'Sohu SMS challenge has expired; restart login');
    }
    await mobile.fill(input.mobile);
    await page.locator(SELECTORS.smsCaptchaInput).fill(input.image_captcha);
    await this.acceptProtocol(page);
    const getCode = page.locator(SELECTORS.smsGetCode);
    await getCode.click();
    const sent = await page
      .waitForFunction(
        `(() => { const value = document.querySelector('[data-role="dynamic-get"]')?.textContent || ''; return value.trim() !== '获取验证码'; })()`,
        undefined,
        { timeout: this.config.navigationTimeoutMs },
      )
      .then(() => true)
      .catch(() => false);
    if (!sent) throw new PageDriverError('AUTH_REQUIRED', 'Sohu rejected the image CAPTCHA');
    return Object.freeze({ expiresAt, qrPng: Buffer.alloc(0), smsCodeRequired: true });
  }

  private async verifySmsCode(
    accountId: string,
    page: Page,
    expiresAt: Date,
    input: Extract<SohuBrowserLoginRequest, { method: 'sms_verify' }>,
  ): Promise<LoginStartResult> {
    const mobile = page.locator(SELECTORS.smsMobile);
    if (!(await mobile.isVisible().catch(() => false))) {
      throw new PageDriverError('AUTH_REQUIRED', 'Sohu SMS challenge has expired; restart login');
    }
    await mobile.fill(input.mobile);
    await page.locator(SELECTORS.smsCode).fill(input.sms_code);
    await this.acceptProtocol(page);
    await page.locator('[data-role="submit-mobile"]').click();
    const authenticated = await this.waitForAuthentication(
      accountId,
      new Date(Date.now() + this.config.navigationTimeoutMs),
    );
    if (!authenticated) {
      await page
        .locator(SELECTORS.smsCode)
        .fill('')
        .catch(() => undefined);
      throw new PageDriverError(
        'AUTH_REQUIRED',
        'Sohu SMS login did not establish an authenticated editor session',
      );
    }
    return Object.freeze({ expiresAt, qrPng: Buffer.alloc(0) });
  }

  public async waitForAuthentication(accountId: string, expiresAt: Date): Promise<boolean> {
    const page = this.pages.get(accountId);
    if (!page) return false;
    const timeout = Math.max(1, expiresAt.getTime() - Date.now());
    const loginUrl = new URL(this.config.loginUrl);
    await page
      .waitForFunction(
        `(() => location.hostname !== ${JSON.stringify(loginUrl.hostname)} || location.pathname !== ${JSON.stringify(loginUrl.pathname)})()`,
        undefined,
        { timeout },
      )
      .catch(() => undefined);
    await this.rejectOAuthFailure(page);
    await this.openEditor(page);
    await this.rejectCaptcha(page);
    await this.rejectMissingArticlePermission(page);
    return this.isAuthenticatedEditor(page);
  }

  public async verifyAuthenticated(
    accountId: string,
    profilePath: string,
    storageStateJson: string | null,
  ): Promise<boolean> {
    const page = await this.page(accountId, profilePath, storageStateJson);
    await this.openEditor(page);
    await this.rejectCaptcha(page);
    await this.rejectMissingArticlePermission(page);
    return this.isAuthenticatedEditor(page);
  }

  public async exportStorageState(accountId: string): Promise<string> {
    const context = this.contexts.get(accountId);
    if (!context) throw new PageDriverError('AUTH_REQUIRED', 'Browser context is unavailable');
    return JSON.stringify(await context.storageState());
  }

  public async submit(
    input: DriverPublishInput,
    beforeSubmit: (png: Uint8Array) => Promise<void>,
  ): Promise<RemotePublication> {
    let stage: PublishOperationStage = 'load_editor';
    try {
      const page = await this.page(input.accountId, input.profilePath, input.storageStateJson);
      await this.openEditor(page);
      stage = 'verify_editor';
      await this.rejectCaptcha(page);
      await this.requireEditor(page);
      const title = page.locator(SELECTORS.title).first();
      const body = page.locator(SELECTORS.body).first();
      stage = 'fill_title';
      await title.fill(input.payload.title);
      stage = 'fill_body';
      await fillBody(body, input.payload.body_html);
      stage = 'upload_images';
      await uploadImages(page, input);
      stage = 'fill_abstract';
      await fillOptional(page, SELECTORS.abstract, input.payload.abstract);
      await selectAiDeclaration(page, this.config.navigationTimeoutMs);
      stage = 'verify_pre_submit';
      await this.rejectCaptcha(page);
      await verifyContent(title, body, input);
      stage = 'capture_pre_submit';
      const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
      stage = 'persist_pre_submit';
      await beforeSubmit(screenshot);
      stage = 'submit';
      const submit = page.locator(SELECTORS.publish).last();
      await submit.waitFor({ state: 'visible', timeout: this.config.navigationTimeoutMs });
      await submit.click();
      await waitForSubmitResult(page, this.config.navigationTimeoutMs);
      const match = {
        contentFingerprint: input.contentFingerprint,
        submittedAfter: new Date(Date.now() - 5 * 60_000),
        title: input.payload.title,
      };
      let reconciled: RemotePublication | null = null;
      for (let attempt = 0; attempt < 3 && !reconciled; attempt += 1) {
        reconciled = await this.reconcile(
          input.accountId,
          input.profilePath,
          match,
          input.storageStateJson,
        );
        if (!reconciled && attempt < 2) {
          await this.pages.get(input.accountId)?.waitForTimeout(2_000);
        }
      }
      if (!reconciled) {
        throw new PageDriverError(
          'PUBLISH_STATE_UNKNOWN',
          'Sohu submission is not yet visible in content management',
        );
      }
      return reconciled;
    } catch (error) {
      if (error instanceof PageDriverError || error instanceof PageDriverOperationError)
        throw error;
      throw new PageDriverOperationError(stage, error);
    }
  }

  public async reconcile(
    accountId: string,
    profilePath: string,
    match: {
      readonly contentFingerprint: string;
      readonly submittedAfter: Date;
      readonly title: string;
    },
    storageStateJson: string | null,
  ): Promise<RemotePublication | null> {
    void match.contentFingerprint;
    const page = await this.page(accountId, profilePath, storageStateJson);
    await page.goto(this.config.manageUrl, { waitUntil: 'domcontentloaded' });
    await this.rejectCaptcha(page);
    await page
      .locator(`${SELECTORS.managePublish}, ${SELECTORS.authenticated}, ${SELECTORS.title}`)
      .first()
      .waitFor({ state: 'visible', timeout: this.config.navigationTimeoutMs })
      .catch(() => undefined);
    if (!(await this.isAuthenticated(page))) {
      throw new PageDriverError('AUTH_REQUIRED', 'Sohu browser login is required');
    }
    const title = normalizeText(match.title);
    const candidates = page.locator('li, tr, [class*="article"], [class*="content-item"]');
    const count = Math.min(await candidates.count(), 200);
    const matches: RemotePublication[] = [];
    for (let index = 0; index < count; index += 1) {
      const row = candidates.nth(index);
      const text = await row.innerText().catch(() => '');
      if (!normalizeText(text).includes(title)) continue;
      const link = row.locator('a[href*="article"], a[href*="news"], a[href]').first();
      const href = await link.getAttribute('href').catch(() => null);
      const externalId = extractExternalId(href);
      if (!externalId) continue;
      const status = remoteStatus(text);
      if (status === 'unknown') continue;
      matches.push(
        Object.freeze({
          externalId,
          reviewReason: failureReason(text),
          status,
          url: href ? new URL(href, this.config.manageUrl).toString() : null,
        }),
      );
    }
    const unique = [...new Map(matches.map((item) => [item.externalId, item])).values()];
    if (unique.length > 1) {
      throw new PageDriverError(
        'MULTIPLE_MATCHES',
        'Sohu content list contains multiple matching publications',
      );
    }
    return unique[0] ?? null;
  }

  public async capture(accountId: string): Promise<Uint8Array> {
    const page = this.pages.get(accountId);
    if (!page) throw new PageDriverError('AUTH_REQUIRED', 'Browser page is unavailable');
    return page.screenshot({ fullPage: true, type: 'png' });
  }

  public async close(): Promise<void> {
    await Promise.all([...this.contexts.values()].map((context) => context.close()));
    this.contexts.clear();
    this.pages.clear();
  }

  private async page(
    accountId: string,
    profilePath: string,
    storageStateJson: string | null,
  ): Promise<Page> {
    const existing = this.pages.get(accountId);
    if (existing && !existing.isClosed()) return existing;
    await mkdir(dirname(profilePath), { recursive: true });
    const context = await chromium.launchPersistentContext(profilePath, {
      headless: this.config.headless,
      viewport: { height: 900, width: 1440 },
    });
    if (storageStateJson) await restoreStorageState(context, storageStateJson);
    context.setDefaultTimeout(this.config.navigationTimeoutMs);
    const page = context.pages()[0] ?? (await context.newPage());
    this.contexts.set(accountId, context);
    this.pages.set(accountId, page);
    return page;
  }

  private async rejectCaptcha(page: Page): Promise<void> {
    if (
      await page
        .locator(SELECTORS.captcha)
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      throw new PageDriverError('CAPTCHA_REQUIRED', 'Sohu requires manual security verification');
    }
  }

  private async openEditor(page: Page): Promise<void> {
    await page.goto(this.config.editorUrl, { waitUntil: 'domcontentloaded' });
    const title = page.locator(SELECTORS.title).first();
    const publishEntry = page.locator(SELECTORS.managePublish).first();
    const destination = await Promise.race([
      title
        .waitFor({ state: 'visible', timeout: this.config.navigationTimeoutMs })
        .then(() => 'editor' as const),
      publishEntry
        .waitFor({ state: 'visible', timeout: this.config.navigationTimeoutMs })
        .then(() => 'manage' as const),
    ]).catch(() => 'unknown' as const);
    if (destination !== 'manage') return;
    await publishEntry.click();
    await title
      .waitFor({ state: 'visible', timeout: this.config.navigationTimeoutMs })
      .catch(() => undefined);
  }

  private async rejectOAuthFailure(page: Page): Promise<void> {
    const failedBinding =
      page.url().includes('/spassport/bind/') ||
      (await page
        .getByText('服务器已被外星人劫持', { exact: false })
        .isVisible()
        .catch(() => false)) ||
      (await page
        .locator('img[src*="img_404"]')
        .isVisible()
        .catch(() => false));
    if (failedBinding) {
      throw new PageDriverError(
        'AUTH_REQUIRED',
        'Sohu WeChat OAuth binding failed; use an account already bound to this WeChat identity',
      );
    }
  }

  private async rejectMissingArticlePermission(page: Page): Promise<void> {
    const body = await page
      .locator('body')
      .innerText()
      .catch(() => '');
    if (/您的账号未实名[\s\S]*仅支持发布动态/u.test(body)) {
      throw new PageDriverError(
        'ACCOUNT_PERMISSION_REQUIRED',
        'Sohu account is not verified and cannot publish articles',
      );
    }
  }

  private async requireEditor(page: Page): Promise<void> {
    if (await this.isAuthenticatedEditor(page)) return;
    if (!(await this.isAuthenticated(page))) {
      throw new PageDriverError('AUTH_REQUIRED', 'Sohu browser login is required');
    }
    throw new PageDriverError(
      'PAGE_SIGNATURE_CHANGED',
      'Sohu editor no longer matches the frozen page signature',
    );
  }

  private async isAuthenticatedEditor(page: Page): Promise<boolean> {
    return (
      (await page
        .locator(SELECTORS.title)
        .first()
        .isVisible()
        .catch(() => false)) &&
      (await page
        .locator(SELECTORS.body)
        .first()
        .isVisible()
        .catch(() => false))
    );
  }

  private async isAuthenticated(page: Page): Promise<boolean> {
    if (await this.isAuthenticatedEditor(page)) return true;
    if (page.url().includes('/signin')) return false;
    if (
      await page
        .locator(SELECTORS.managePublish)
        .first()
        .isVisible()
        .catch(() => false)
    )
      return true;
    return page
      .locator(SELECTORS.authenticated)
      .first()
      .isVisible()
      .catch(() => false);
  }
}

async function fillBody(body: Locator, html: string): Promise<void> {
  await body.evaluate((element, value) => {
    element.innerHTML = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, html);
}

async function uploadImages(page: Page, input: DriverPublishInput): Promise<void> {
  const images = input.images;
  if (images.length === 0) return;
  for (const image of images) {
    const initialCount = await page.locator('.ql-editor img').count();
    const trigger = page.locator('.ql-image, button[title*="图片"]').first();
    if (!(await trigger.isVisible().catch(() => false))) {
      throw new PageDriverError(
        'PAGE_SIGNATURE_CHANGED',
        'Sohu editor image upload entry was not found',
      );
    }
    await trigger.click();
    const fileInput = page.locator('#new-file, input[type="file"][accept*="image"]').last();
    await fileInput.waitFor({ state: 'attached', timeout: 5_000 });
    await fileInput.setInputFiles({
      buffer: Buffer.from(image.body),
      mimeType: image.mimeType,
      name: `${image.assetId}.${extension(image.mimeType)}`,
    });
    const expectedCount = initialCount + 1;
    const outcome = await Promise.race([
      page
        .waitForFunction(
          `(() => document.querySelectorAll('.ql-editor img').length >= ${expectedCount})()`,
          undefined,
          { timeout: 30_000 },
        )
        .then(() => 'inserted' as const),
      page
        .getByText(/已成功上传\d+张图片/u)
        .last()
        .waitFor({ state: 'visible', timeout: 30_000 })
        .then(() => 'uploaded' as const),
    ]);
    if (outcome === 'uploaded') {
      const confirm = page.locator('p.button.positive-button').filter({ hasText: '确定' }).last();
      await confirm.waitFor({ state: 'visible', timeout: 5_000 });
      await confirm.click();
      await page.waitForFunction(
        `(() => document.querySelectorAll('.ql-editor img').length >= ${expectedCount})()`,
        undefined,
        { timeout: 30_000 },
      );
    }
  }
}

async function selectAiDeclaration(page: Page, timeoutMs: number): Promise<void> {
  const declaration = page.locator(SELECTORS.declarationAi).first();
  const visible = await declaration
    .waitFor({ state: 'visible', timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
  if (!visible) {
    throw new PageDriverError(
      'PAGE_SIGNATURE_CHANGED',
      'Sohu AI-content declaration control was not found',
    );
  }
  await declaration.click();
  const radio = declaration.locator('input[type="radio"]').first();
  if (!(await radio.isChecked().catch(() => false))) {
    throw new PageDriverError(
      'PAGE_SIGNATURE_CHANGED',
      'Sohu AI-content declaration was not selected',
    );
  }
}

async function fillOptional(page: Page, selector: string, value: string): Promise<void> {
  const field = page.locator(selector).first();
  if (await field.isVisible().catch(() => false)) await field.fill(value);
}

async function verifyContent(
  title: Locator,
  body: Locator,
  input: DriverPublishInput,
): Promise<void> {
  if ((await title.inputValue()) !== input.payload.title) {
    throw new PageDriverError('PAGE_SIGNATURE_CHANGED', 'Sohu editor did not preserve the title');
  }
  const actual = normalizeText(await body.innerText());
  const expected = normalizeText(input.payload.body_text.replace(/^##\s*/gmu, ''));
  if (!actual || !expected || actual.length < expected.length * 0.8) {
    throw new PageDriverError(
      'PAGE_SIGNATURE_CHANGED',
      'Sohu editor did not preserve the complete body',
    );
  }
}

async function waitForSubmitResult(page: Page, timeoutMs: number): Promise<void> {
  const success = page.getByText(/发布成功|审核中|已发布/u).first();
  const failure = page.getByText(/发布失败|没有发文权限|未实名|网络原因/u).first();
  await Promise.race([
    success.waitFor({ state: 'visible', timeout: timeoutMs }),
    failure.waitFor({ state: 'visible', timeout: timeoutMs }).then(async () => {
      throw new PageDriverError('PUBLISH_STATE_UNKNOWN', await failure.innerText());
    }),
    page.waitForURL((url) => !url.pathname.includes('/news/addarticle'), { timeout: timeoutMs }),
  ]).catch((error) => {
    if (error instanceof PageDriverError) throw error;
  });
}

async function restoreStorageState(context: BrowserContext, json: string): Promise<void> {
  const state = JSON.parse(json) as { cookies?: Parameters<BrowserContext['addCookies']>[0] };
  if (state.cookies?.length) await context.addCookies(state.cookies);
}

function extractExternalId(href: string | null): string | null {
  if (!href) return null;
  return (
    /(?:id|newsId)=([A-Za-z0-9_-]+)/u.exec(href)?.[1] ??
    /\/([0-9]{5,})(?:[/?#]|$)/u.exec(href)?.[1] ??
    null
  );
}

function remoteStatus(value: string): RemotePublication['status'] {
  if (/已发布/u.test(value)) return 'published';
  if (/失败|未通过/u.test(value)) return 'failed';
  if (/审核中|待审核|处理中/u.test(value)) return 'processing';
  return 'unknown';
}

function failureReason(value: string): string | null {
  return /失败|未通过/u.test(value) ? value.slice(0, 500) : null;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, '').trim();
}

function extension(mimeType: DriverPublishInput['images'][number]['mimeType']): string {
  return mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice('image/'.length);
}
