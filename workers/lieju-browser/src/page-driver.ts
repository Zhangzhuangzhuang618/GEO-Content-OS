import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import type { LiejuBrowserLoginRequest } from '@geo-content-os/contracts';

import type { LiejuBrowserConfig } from './config.js';
import type {
  DriverPublishInput,
  LiejuPageDriver,
  LoginStartResult,
  RemotePublication,
} from './types.js';

const SELECTORS = Object.freeze({
  address: '#atc_dizhi',
  authenticated: 'a[href*="action=quit"], a[href*="/member/"]',
  captcha: '#TencentCaptcha, iframe[src*="captcha.gtimg.com"], .tcaptcha-transform',
  category: '#atc_leibie',
  contactName: '#atc_linkman',
  content: '#atc_content',
  image: '#in_url1',
  loginPassword: 'input[name="password"]',
  loginSubmit: 'input[type="submit"]',
  loginUsername: 'input[name="username"]',
  mobilePhone: '#atc_mobphone',
  qq: '#atc_oicq',
  submit: '#sub',
  title: '#atc_title',
  wechat: '#atc_wechat',
  zone: '#atc_zone_id',
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
  | 'fill_form'
  | 'load_editor'
  | 'persist_pre_submit'
  | 'submit'
  | 'upload_image'
  | 'verify_editor'
  | 'verify_pre_submit';

export class PageDriverOperationError extends Error {
  public constructor(
    public readonly stage: PublishOperationStage,
    cause: unknown,
  ) {
    super('Lieju browser operation failed', { cause });
    this.name = 'PageDriverOperationError';
  }
}

export class PlaywrightLiejuPageDriver implements LiejuPageDriver {
  private readonly contexts = new Map<string, BrowserContext>();
  private readonly pages = new Map<string, Page>();

  public constructor(private readonly config: LiejuBrowserConfig) {}

  public async startLogin(
    accountId: string,
    profilePath: string,
    input: LiejuBrowserLoginRequest = { method: 'qq' },
  ): Promise<LoginStartResult> {
    const page = await this.page(accountId, profilePath, null);
    const loginUrl =
      input.method === 'password'
        ? new URL('/login/', this.config.loginUrl).toString()
        : this.config.loginUrl;
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    const expiresAt = new Date(Date.now() + 180_000);
    if (await this.isAuthenticated(page)) return { expiresAt, qrPng: Buffer.alloc(0) };
    if (input.method === 'password') {
      await page.locator(SELECTORS.loginUsername).fill(input.username);
      await page.locator(SELECTORS.loginPassword).fill(input.password);
      const remember = page.locator('input[name="cookietime"]');
      if (await remember.isChecked().catch(() => false)) await remember.uncheck();
      await page.locator(SELECTORS.loginSubmit).click();
      const authenticated = await this.waitForAuthentication(
        accountId,
        new Date(Date.now() + this.config.navigationTimeoutMs),
      );
      if (!authenticated) {
        await page
          .locator(SELECTORS.loginPassword)
          .fill('')
          .catch(() => undefined);
        throw new PageDriverError(
          'AUTH_REQUIRED',
          'Lieju login did not reach an authenticated member page before timeout',
        );
      }
      return Object.freeze({ expiresAt, qrPng: Buffer.alloc(0) });
    }
    if (this.config.simulator) {
      const qr = page.locator('[data-lieju-qq-qr]').first();
      await qr.waitFor({ state: 'visible', timeout: this.config.navigationTimeoutMs });
      return Object.freeze({ expiresAt, qrPng: await qr.screenshot({ type: 'png' }) });
    }
    await page.waitForURL(/graph\.qq\.com|xui\.ptlogin2\.qq\.com/u, {
      timeout: this.config.navigationTimeoutMs,
    });
    await page.waitForTimeout(1_500);
    const qrFrame = page.frames().find((frame) => frame.url().includes('ptlogin2.qq.com'));
    const qrRegion = qrFrame?.locator('body') ?? page.locator('body');
    return Object.freeze({ expiresAt, qrPng: await qrRegion.screenshot({ type: 'png' }) });
  }

  public async waitForAuthentication(accountId: string, expiresAt: Date): Promise<boolean> {
    const page = this.pages.get(accountId);
    if (!page) return false;
    while (Date.now() < expiresAt.getTime()) {
      if (await this.loginCaptchaVisible(page)) {
        throw new PageDriverError(
          'CAPTCHA_REQUIRED',
          'Lieju requires interactive CAPTCHA to complete login',
        );
      }
      if (await this.loginRejected(page)) {
        throw new PageDriverError('AUTH_REQUIRED', 'Lieju did not accept the account credentials');
      }
      if (await this.isAuthenticated(page)) {
        await this.openEditor(page);
        return this.isAuthenticatedEditor(page);
      }
      await page.waitForTimeout(Math.min(250, Math.max(1, expiresAt.getTime() - Date.now())));
    }
    return false;
  }

  public async verifyAuthenticated(
    accountId: string,
    profilePath: string,
    storageStateJson: string | null,
  ): Promise<boolean> {
    const page = await this.page(accountId, profilePath, storageStateJson);
    await this.openEditor(page);
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
      await this.requireEditor(page);
      stage = 'fill_form';
      await fillForm(page, input);
      stage = 'upload_image';
      await uploadImage(page, input);
      stage = 'verify_pre_submit';
      await verifyForm(page, input);
      await this.rejectCaptcha(page);
      stage = 'capture_pre_submit';
      const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
      stage = 'persist_pre_submit';
      await beforeSubmit(screenshot);
      stage = 'submit';
      await page.locator(SELECTORS.submit).click();
      await waitForSubmitResult(page, this.config.editorUrl, this.config.navigationTimeoutMs);
      const match = {
        contentFingerprint: input.contentFingerprint,
        submittedAfter: new Date(Date.now() - 5 * 60_000),
        title: input.payload.title,
      };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const remote = await this.reconcile(
          input.accountId,
          input.profilePath,
          match,
          input.storageStateJson,
        );
        if (remote) return remote;
        if (attempt < 2) await page.waitForTimeout(2_000);
      }
      throw new PageDriverError(
        'PUBLISH_STATE_UNKNOWN',
        'Lieju submission is not yet visible in member content management',
      );
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
    void match.submittedAfter;
    const page = await this.page(accountId, profilePath, storageStateJson);
    await page.goto(this.config.manageUrl, { waitUntil: 'domcontentloaded' });
    if (!(await this.isAuthenticated(page))) {
      throw new PageDriverError('AUTH_REQUIRED', 'Lieju browser login is required');
    }
    const expectedTitle = normalizeText(match.title);
    const candidates = page.locator('tr, li, [class*="list"], [class*="info"]');
    const count = Math.min(await candidates.count(), 300);
    const matches: RemotePublication[] = [];
    for (let index = 0; index < count; index += 1) {
      const row = candidates.nth(index);
      const text = await row.innerText().catch(() => '');
      if (!normalizeText(text).includes(expectedTitle)) continue;
      const links = row.locator('a[href]');
      const linkCount = await links.count();
      let publicUrl: string | null = null;
      for (let linkIndex = 0; linkIndex < linkCount; linkIndex += 1) {
        const href = await links.nth(linkIndex).getAttribute('href');
        if (href && this.isPublicContentUrl(href)) {
          publicUrl = new URL(href, this.config.manageUrl).toString();
          break;
        }
      }
      const externalId = extractExternalId(publicUrl) ?? (await extractRowId(row, text));
      if (!externalId) continue;
      const verifiedPublicUrl =
        publicUrl && (await verifyPublicPage(page, publicUrl, match.title)) ? publicUrl : null;
      const status = remoteStatus(text, verifiedPublicUrl);
      matches.push(
        Object.freeze({
          externalId,
          reviewReason: failureReason(text),
          status,
          url: status === 'published' ? verifiedPublicUrl : null,
        }),
      );
    }
    const unique = [...new Map(matches.map((item) => [item.externalId, item])).values()];
    if (unique.length > 1) {
      throw new PageDriverError(
        'MULTIPLE_MATCHES',
        'Lieju member list contains multiple matching publications',
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

  private async openEditor(page: Page): Promise<void> {
    await page.goto(this.config.editorUrl, { waitUntil: 'domcontentloaded' });
    await page
      .locator(`${SELECTORS.title}, a[href*="/login/"]`)
      .first()
      .waitFor({
        state: 'visible',
        timeout: this.config.navigationTimeoutMs,
      })
      .catch(() => undefined);
  }

  private async rejectCaptcha(page: Page): Promise<void> {
    const marker = page.locator(SELECTORS.captcha).first();
    const hiddenPass = await page
      .locator('#atc_yzm')
      .inputValue()
      .catch(() => '');
    if ((await marker.isVisible().catch(() => false)) && hiddenPass !== '1') {
      throw new PageDriverError(
        'CAPTCHA_REQUIRED',
        'Lieju requires Tencent interactive CAPTCHA; use a captcha-free posting package or handle manually',
      );
    }
  }

  private async loginCaptchaVisible(page: Page): Promise<boolean> {
    return page
      .locator(SELECTORS.captcha)
      .first()
      .isVisible()
      .catch(() => false);
  }

  private async loginRejected(page: Page): Promise<boolean> {
    if (!page.url().includes('/login/')) return false;
    const text = await page
      .locator('body')
      .innerText()
      .catch(() => '');
    return /(?:用户名|账号|密码).{0,16}(?:错误|不正确|不存在|无效)|登录失败/u.test(text);
  }

  private async requireEditor(page: Page): Promise<void> {
    if (await this.isAuthenticatedEditor(page)) return;
    if (!(await this.isAuthenticated(page))) {
      throw new PageDriverError('AUTH_REQUIRED', 'Lieju browser login is required');
    }
    throw new PageDriverError(
      'PAGE_SIGNATURE_CHANGED',
      'Lieju moving-services form no longer matches the frozen page signature',
    );
  }

  private async isAuthenticatedEditor(page: Page): Promise<boolean> {
    return (
      (await page
        .locator(SELECTORS.title)
        .isVisible()
        .catch(() => false)) &&
      (await page
        .locator(SELECTORS.content)
        .isVisible()
        .catch(() => false))
    );
  }

  private async isAuthenticated(page: Page): Promise<boolean> {
    if (await this.isAuthenticatedEditor(page)) return true;
    if (page.url().includes('/login/')) return false;
    return page
      .locator(SELECTORS.authenticated)
      .first()
      .isVisible()
      .catch(() => false);
  }

  private isPublicContentUrl(href: string): boolean {
    if (/\.lieju\.com\/.+\/\d+\.html(?:[?#].*)?$/u.test(href)) return true;
    if (!this.config.simulator) return false;
    const url = new URL(href, this.config.manageUrl);
    return (
      url.hostname === new URL(this.config.manageUrl).hostname && /\/\d+\.html$/u.test(url.pathname)
    );
  }
}

async function fillForm(page: Page, input: DriverPublishInput): Promise<void> {
  const profile = input.postingProfile;
  await page.locator(SELECTORS.zone).selectOption(profile.zone_id);
  if (profile.street_id) {
    const street = page.locator('#atc_street_id');
    await street.waitFor({ state: 'visible', timeout: 5_000 });
    await street.selectOption(profile.street_id);
  }
  await page.locator(SELECTORS.title).fill(input.payload.title);
  await page.locator(SELECTORS.category).selectOption(profile.category_id);
  await page.locator(SELECTORS.address).fill(profile.address);
  await page.locator(SELECTORS.content).fill(input.payload.body_text);
  await page.locator(SELECTORS.mobilePhone).fill(profile.mobile_phone);
  await page.locator(SELECTORS.qq).fill(profile.qq);
  await page.locator(SELECTORS.wechat).fill(profile.wechat);
  await page.locator(SELECTORS.contactName).fill(profile.contact_name);
  await page.locator('#atc_autofill').selectOption('0');
  const paidPromotion = page.locator('#dtop');
  if (await paidPromotion.isChecked().catch(() => false)) await paidPromotion.uncheck();
}

async function uploadImage(page: Page, input: DriverPublishInput): Promise<void> {
  const image = input.images[0];
  if (!image) return;
  if (image.mimeType === 'image/webp') {
    throw new PageDriverError('PAGE_SIGNATURE_CHANGED', 'Lieju does not accept WebP images');
  }
  await page.locator(SELECTORS.image).setInputFiles({
    buffer: Buffer.from(image.body),
    mimeType: image.mimeType,
    name: `${image.assetId}.${extension(image.mimeType)}`,
  });
  await page.waitForTimeout(500);
  const imageError = await page
    .locator('#previewerr1')
    .innerText()
    .catch(() => '');
  if (imageError.trim()) {
    throw new PageDriverError('PAGE_SIGNATURE_CHANGED', imageError.trim());
  }
  const uploadedFiles = await page.locator(SELECTORS.image).evaluate((element) => {
    const input = element as unknown as { files?: { readonly length: number } | null };
    return input.files?.length ?? 0;
  });
  const previewSource = await page
    .locator('#preview1 img')
    .getAttribute('src')
    .catch(() => null);
  if (uploadedFiles !== 1 && !previewSource?.trim()) {
    throw new PageDriverError(
      'PAGE_SIGNATURE_CHANGED',
      'Lieju rejected the selected image without creating a preview',
    );
  }
}

async function verifyForm(page: Page, input: DriverPublishInput): Promise<void> {
  const values: readonly [string, string][] = [
    [SELECTORS.title, input.payload.title],
    [SELECTORS.content, input.payload.body_text],
    [SELECTORS.mobilePhone, input.postingProfile.mobile_phone],
    [SELECTORS.contactName, input.postingProfile.contact_name],
  ];
  for (const [selector, expected] of values) {
    if ((await page.locator(selector).inputValue()) !== expected) {
      throw new PageDriverError(
        'PAGE_SIGNATURE_CHANGED',
        `Lieju form did not preserve ${selector}`,
      );
    }
  }
}

async function waitForSubmitResult(
  page: Page,
  editorUrl: string,
  timeoutMs: number,
): Promise<void> {
  const editorPath = new URL(editorUrl).pathname.replace(/\/+$/u, '');
  const failure = page.getByText(/发布失败|每天可发布|验证码|错误/u).first();
  await Promise.race([
    page.waitForURL((url) => url.pathname.replace(/\/+$/u, '') !== editorPath, {
      timeout: timeoutMs,
    }),
    page
      .getByText(/发布成功|提交成功|审核/u)
      .first()
      .waitFor({ state: 'visible', timeout: timeoutMs }),
    failure.waitFor({ state: 'visible', timeout: timeoutMs }).then(async () => {
      throw new PageDriverError('PUBLISH_STATE_UNKNOWN', await failure.innerText());
    }),
  ]).catch((error) => {
    if (error instanceof PageDriverError) throw error;
  });
}

async function restoreStorageState(context: BrowserContext, json: string): Promise<void> {
  const state = JSON.parse(json) as { cookies?: Parameters<BrowserContext['addCookies']>[0] };
  if (state.cookies?.length) await context.addCookies(state.cookies);
}

async function verifyPublicPage(page: Page, url: string, title: string): Promise<boolean> {
  const publicPage = await page.context().newPage();
  try {
    const response = await publicPage.goto(url, { waitUntil: 'domcontentloaded' });
    if (!response?.ok()) return false;
    const text = normalizeText(await publicPage.locator('body').innerText());
    return text.includes(normalizeText(title));
  } catch {
    return false;
  } finally {
    await publicPage.close();
  }
}

function extractExternalId(href: string | null): string | null {
  return href ? (/\/(\d+)\.html(?:[?#].*)?$/u.exec(href)?.[1] ?? null) : null;
}

async function extractRowId(row: Locator, text: string): Promise<string | null> {
  const checkbox = row.locator('input[type="checkbox"][value]').first();
  const value = await checkbox.getAttribute('value').catch(() => null);
  return value && /^\d+$/u.test(value)
    ? value
    : (/(?:ID|编号)[：:\s]*(\d+)/u.exec(text)?.[1] ?? null);
}

function remoteStatus(value: string, publicUrl: string | null): RemotePublication['status'] {
  if (/删除|未通过|违规/u.test(value)) return 'failed';
  if (/未审核|待审核|审核中/u.test(value)) return 'processing';
  if (publicUrl) return 'published';
  return 'processing';
}

function failureReason(value: string): string | null {
  return /删除|未通过|违规/u.test(value) ? value.slice(0, 500) : null;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, '').trim();
}

function extension(mimeType: DriverPublishInput['images'][number]['mimeType']): string {
  return mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice('image/'.length);
}
