import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';

import type { BaijiahaoBrowserConfig } from './config.js';
import type {
  BaijiahaoPageDriver,
  DriverPublishInput,
  LoginStartResult,
  RemotePublication,
} from './types.js';

const SELECTORS = Object.freeze({
  abstract: 'textarea[placeholder*="摘要"], textarea[data-field="abstract"]',
  aiGenerated: 'label:has-text("采用AI生成内容")',
  authenticated: '[data-testid="account-menu"], .user-info, .user-name',
  authenticatedManage:
    '[data-testid="content-list"], [class*="client_pages_content_v2_components_articleList"], .content-list',
  body: '[contenteditable="true"][data-field="body"], .ProseMirror, [contenteditable="true"]',
  bodyImages:
    'input[type="file"][data-field="body-images"], input[type="file"][multiple][accept*="image"]',
  bodyImageTrigger: '[data-function="insertimage"]',
  captcha: 'iframe[src*="captcha"], [class*="captcha"], text=/验证码|安全验证/u',
  category: 'select[data-field="category"], select[name*="category"]',
  contentList:
    '[data-testid="content-list"], [class*="client_pages_content_v2_components_articleList"], .content-list, table, text=/内容管理|作品管理|我的内容|暂无内容/u',
  contentRow:
    '[data-publication-row], [class*="client_pages_content_v2_components_articleItem"], .content-item, tr',
  cover:
    'input[type="file"][data-field="cover"], input[type="file"][name*="cover"], input[type="file"][name="media"][accept*="image"]',
  coverTrigger: 'text="选择封面"',
  fingerprint: 'input[data-field="fingerprint"]',
  loginTrigger: '[data-testid="bjh-login-btn"], button:has-text("登录/注册百家号")',
  noCover: '[data-testid="no-cover"], label:has-text("无封面"), button:has-text("无封面")',
  notOriginal: '[data-testid="not-original"], label:has-text("非原创")',
  qr: '[data-testid="login-qr"], img.tang-pass-qrcode-img, img[src*="/v2/api/qrcode"]',
  submit:
    '[data-testid="publish-btn"], [data-testid="submit"], button:has-text("发布"), button:has-text("提交")',
  tags: 'input[placeholder*="标签"], input[data-field="tags"]',
  title:
    '[data-testid="news-title-input"] [contenteditable="true"], input[placeholder*="标题"], textarea[placeholder*="标题"], input[data-field="title"]',
});

export class PageDriverError extends Error {
  public constructor(
    public readonly code:
      | 'AUTH_REQUIRED'
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
  | 'fill_fingerprint'
  | 'fill_tags'
  | 'fill_title'
  | 'load_editor'
  | 'mark_ai_generated'
  | 'persist_pre_submit'
  | 'select_category'
  | 'select_no_cover'
  | 'select_originality'
  | 'upload_body_images'
  | 'upload_cover'
  | 'verify_editor'
  | 'verify_pre_submit';

export class PageDriverOperationError extends Error {
  public constructor(
    public readonly stage: PublishOperationStage,
    cause: unknown,
  ) {
    super('Baijiahao browser operation failed', { cause });
    this.name = 'PageDriverOperationError';
  }
}

export class PlaywrightBaijiahaoPageDriver implements BaijiahaoPageDriver {
  private readonly contexts = new Map<string, BrowserContext>();
  private readonly loginPageUrls = new Map<string, string>();
  private readonly pages = new Map<string, Page>();

  public constructor(private readonly config: BaijiahaoBrowserConfig) {}

  public async startLogin(accountId: string, profilePath: string): Promise<LoginStartResult> {
    const page = await this.page(accountId, profilePath, null);
    await page.goto(this.config.loginUrl, { waitUntil: 'domcontentloaded' });
    await this.rejectCaptcha(page);
    const expiresAt = new Date(Date.now() + 120_000);
    if (
      await page
        .locator(SELECTORS.authenticated)
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      return { expiresAt, qrPng: Buffer.alloc(0) };
    }
    const qr = page.locator(SELECTORS.qr).first();
    if (!(await qr.isVisible().catch(() => false))) {
      const loginTrigger = page.locator(SELECTORS.loginTrigger).first();
      if (!(await loginTrigger.isVisible().catch(() => false))) {
        await page.goto(this.config.editorUrl, { waitUntil: 'domcontentloaded' });
        await this.rejectCaptcha(page);
        if (await this.isAuthenticatedEditor(page)) {
          return { expiresAt, qrPng: Buffer.alloc(0) };
        }
        throw new PageDriverError(
          'PAGE_SIGNATURE_CHANGED',
          'Baijiahao login entry no longer matches the frozen page signature',
        );
      }
      await loginTrigger.click();
    }
    await qr.waitFor({ state: 'visible', timeout: this.config.navigationTimeoutMs });
    this.loginPageUrls.set(accountId, page.url());
    try {
      await page.waitForFunction(
        `(() => {
          const image = document.querySelector(${JSON.stringify(SELECTORS.qr)});
          return image instanceof HTMLImageElement
            && image.complete
            && image.naturalWidth >= 200
            && image.naturalHeight >= 200
            && image.src.includes('/v2/api/qrcode');
        })()`,
        undefined,
        { timeout: this.config.navigationTimeoutMs },
      );
    } catch {
      throw new PageDriverError(
        'PAGE_SIGNATURE_CHANGED',
        'Baijiahao login QR code did not finish loading',
      );
    }
    return Object.freeze({ expiresAt, qrPng: await qr.screenshot({ type: 'png' }) });
  }

  public async waitForAuthentication(accountId: string, expiresAt: Date): Promise<boolean> {
    const page = this.pages.get(accountId);
    if (!page) return false;
    const timeout = Math.max(1, expiresAt.getTime() - Date.now());
    const loginPageUrl = this.loginPageUrls.get(accountId) ?? page.url();
    this.loginPageUrls.delete(accountId);
    const loginObserved = await page
      .waitForFunction(
        `(() => {
          const authenticated = document.querySelector(${JSON.stringify(SELECTORS.authenticated)});
          if (authenticated instanceof HTMLElement && authenticated.offsetParent !== null) {
            return true;
          }
          return window.location.href !== ${JSON.stringify(loginPageUrl)};
        })()`,
        undefined,
        { timeout },
      )
      .then(() => true)
      .catch(() => false);
    if (!loginObserved) return false;
    await page.goto(this.config.editorUrl, { waitUntil: 'domcontentloaded' });
    await this.rejectCaptcha(page);
    return this.isAuthenticatedEditor(page);
  }

  public async verifyAuthenticated(
    accountId: string,
    profilePath: string,
    storageStateJson: string | null,
  ): Promise<boolean> {
    const page = await this.page(accountId, profilePath, storageStateJson);
    await page.goto(this.config.editorUrl, { waitUntil: 'domcontentloaded' });
    await this.rejectCaptcha(page);
    if (await this.isAuthenticatedEditor(page)) return true;
    return this.verifyViaLoginPage(page);
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
      await page.goto(this.config.editorUrl, { waitUntil: 'domcontentloaded' });
      stage = 'verify_editor';
      await this.rejectCaptcha(page);
      await this.requireAuthenticated(page);
      const title = page.locator(SELECTORS.title).first();
      const body = await this.bodyLocator(page);
      const submit = page.locator(SELECTORS.submit).first();
      for (const locator of [title, body, submit]) {
        if (!(await locator.isVisible().catch(() => false))) {
          throw new PageDriverError(
            'PAGE_SIGNATURE_CHANGED',
            'Baijiahao editor fields no longer match the frozen page signature',
          );
        }
      }
      stage = 'fill_title';
      await title.fill(input.payload.title);
      stage = 'fill_body';
      await body.fill(input.payload.body_text);
      stage = 'upload_cover';
      await uploadCover(
        page,
        input.images.filter((image) => image.role === 'cover'),
      );
      stage = 'upload_body_images';
      await uploadImages(
        page,
        body,
        SELECTORS.bodyImages,
        SELECTORS.bodyImageTrigger,
        input.images.filter((image) => image.role === 'body'),
        this.config.navigationTimeoutMs,
      );
      stage = 'select_no_cover';
      if (input.payload.cover_asset_id === null) await clickOptional(page, SELECTORS.noCover);
      stage = 'select_category';
      await selectOptional(page, SELECTORS.category, input.payload.content_type);
      stage = 'select_originality';
      await clickOptional(page, SELECTORS.notOriginal);
      stage = 'mark_ai_generated';
      await checkOptional(page, SELECTORS.aiGenerated);
      stage = 'fill_abstract';
      await fillOptional(page, SELECTORS.abstract, input.payload.abstract);
      stage = 'fill_tags';
      await fillOptional(page, SELECTORS.tags, input.payload.tags.join(','));
      stage = 'fill_fingerprint';
      await fillOptional(page, SELECTORS.fingerprint, input.contentFingerprint);
      stage = 'verify_pre_submit';
      await this.rejectCaptcha(page);
      stage = 'capture_pre_submit';
      const preSubmit = await page.screenshot({ fullPage: true, type: 'png' });
      stage = 'persist_pre_submit';
      await beforeSubmit(preSubmit);
      try {
        await submit.click();
        await page.waitForLoadState('domcontentloaded', {
          timeout: this.config.navigationTimeoutMs,
        });
      } catch {
        throw new PageDriverError(
          'PUBLISH_STATE_UNKNOWN',
          'Baijiahao submission ended without a conclusive browser state',
        );
      }
      const result = await this.reconcile(
        input.accountId,
        input.profilePath,
        {
          contentFingerprint: input.contentFingerprint,
          submittedAfter: new Date(Date.now() - 5 * 60_000),
          title: input.payload.title,
        },
        input.storageStateJson,
      );
      if (!result) {
        throw new PageDriverError(
          'PUBLISH_STATE_UNKNOWN',
          'Baijiahao content list did not confirm the submitted article',
        );
      }
      return result;
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
    const page = await this.page(accountId, profilePath, storageStateJson);
    await page.goto(this.config.manageUrl, { waitUntil: 'domcontentloaded' });
    await this.rejectCaptcha(page);
    await this.requireAuthenticated(page);
    const rows = page.locator(SELECTORS.contentRow);
    const count = Math.min(await rows.count(), 100);
    if (
      count === 0 &&
      !(await page
        .locator(SELECTORS.contentList)
        .first()
        .isVisible()
        .catch(() => false))
    ) {
      throw new PageDriverError(
        'PAGE_SIGNATURE_CHANGED',
        'Baijiahao content list no longer matches the frozen page signature',
      );
    }
    const matches: RemotePublication[] = [];
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      const explicitTitle = await row.getAttribute('data-title');
      const rowText = await row.innerText();
      const titleMatches = explicitTitle
        ? normalizeText(explicitTitle) === normalizeText(match.title)
        : normalizeText(rowText).includes(normalizeText(match.title));
      const fingerprint = (await row.getAttribute('data-content-fingerprint')) ?? '';
      if (!titleMatches) continue;
      if (fingerprint && fingerprint !== match.contentFingerprint) continue;
      const submittedRaw = await row.getAttribute('data-submitted-at');
      if (submittedRaw) {
        const submittedAt = new Date(submittedRaw);
        if (Number.isNaN(submittedAt.getTime()) || submittedAt < match.submittedAfter) continue;
      }
      const externalId =
        (await row.getAttribute('data-external-id')) ??
        extractExternalId(await row.locator('a').first().getAttribute('href'));
      if (!externalId) continue;
      const statusText = `${await row.getAttribute('data-status')} ${rowText}`;
      const url = await row.locator('a').first().getAttribute('href');
      matches.push(
        Object.freeze({
          externalId,
          reviewReason: (await row.getAttribute('data-review-reason')) ?? null,
          status: remoteStatus(statusText),
          url: normalizeUrl(url, this.config.manageUrl),
        }),
      );
    }
    if (matches.length > 1) {
      throw new PageDriverError(
        'MULTIPLE_MATCHES',
        'Baijiahao content list contains multiple matching publications',
      );
    }
    return matches[0] ?? null;
  }

  public async capture(accountId: string): Promise<Uint8Array> {
    const page = this.pages.get(accountId);
    if (!page) throw new PageDriverError('PAGE_SIGNATURE_CHANGED', 'Browser page is unavailable');
    return page.screenshot({ fullPage: true, type: 'png' });
  }

  public async close(): Promise<void> {
    const contexts = [...this.contexts.values()];
    this.contexts.clear();
    this.loginPageUrls.clear();
    this.pages.clear();
    await Promise.all(contexts.map((context) => context.close()));
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
    context.setDefaultTimeout(this.config.navigationTimeoutMs);
    if (storageStateJson) await restoreStorageState(context, storageStateJson);
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
      throw new PageDriverError('CAPTCHA_REQUIRED', 'Baijiahao requested human verification');
    }
  }

  private async requireAuthenticated(page: Page): Promise<void> {
    if (
      await page
        .locator(SELECTORS.authenticatedManage)
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      return;
    }
    if (await this.isAuthenticatedEditor(page)) return;
    if (!(await this.verifyViaLoginPage(page))) {
      throw new PageDriverError('AUTH_REQUIRED', 'Baijiahao login has expired');
    }
    throw new PageDriverError(
      'PAGE_SIGNATURE_CHANGED',
      'Baijiahao session is active but the requested page is not available',
    );
  }

  private async verifyViaLoginPage(page: Page): Promise<boolean> {
    await page.goto(this.config.loginUrl, { waitUntil: 'domcontentloaded' });
    await this.rejectCaptcha(page);
    if (
      await page
        .locator(SELECTORS.authenticated)
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      return true;
    }
    const loginRequired = await page
      .locator(`${SELECTORS.loginTrigger}, ${SELECTORS.qr}`)
      .first()
      .isVisible()
      .catch(() => false);
    if (loginRequired) return false;
    throw new PageDriverError(
      'PAGE_SIGNATURE_CHANGED',
      'Baijiahao login page no longer exposes an authenticated or login-required state',
    );
  }

  private async isAuthenticatedEditor(page: Page): Promise<boolean> {
    if (
      await page
        .locator(SELECTORS.authenticated)
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      return true;
    }
    try {
      const title = page.locator(SELECTORS.title).first();
      const submit = page.locator(SELECTORS.submit).first();
      await title.waitFor({ state: 'visible', timeout: this.config.navigationTimeoutMs });
      const body = await this.bodyLocator(page);
      await Promise.all([
        body.waitFor({ state: 'visible', timeout: this.config.navigationTimeoutMs }),
        submit.waitFor({ state: 'visible', timeout: this.config.navigationTimeoutMs }),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  private async bodyLocator(page: Page): Promise<Locator> {
    const iframe = page.locator('iframe#ueditor_0');
    if ((await iframe.count()) > 0) {
      return iframe.contentFrame().locator('body[contenteditable="true"]').first();
    }
    return page.locator(SELECTORS.body).first();
  }
}

async function uploadCover(
  page: Page,
  images: readonly DriverPublishInput['images'][number][],
): Promise<void> {
  if (images.length === 0) return;
  const direct = page
    .locator('input[type="file"][data-field="cover"], input[type="file"][name*="cover"]')
    .first();
  if ((await direct.count()) > 0) {
    await setImageFiles(direct, images);
    return;
  }
  const trigger = page.locator(SELECTORS.coverTrigger).first();
  if (!(await trigger.isVisible().catch(() => false))) {
    throw new PageDriverError(
      'PAGE_SIGNATURE_CHANGED',
      'Baijiahao cover upload entry no longer matches the frozen page signature',
    );
  }
  await trigger.click();
  const dialog = page.getByRole('dialog').filter({ hasText: '本地上传' }).first();
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  const locator = dialog.locator(SELECTORS.cover).first();
  if ((await locator.count()) === 0) {
    throw new PageDriverError(
      'PAGE_SIGNATURE_CHANGED',
      'Baijiahao cover upload field no longer matches the frozen page signature',
    );
  }
  await setImageFiles(locator, images);
  const confirm = dialog.getByRole('button', { name: /^确定/u });
  await confirm.waitFor({ state: 'visible', timeout: 10_000 });
  await confirm.click();
  await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
}

async function fillOptional(page: Page, selector: string, value: string): Promise<void> {
  const locator = page.locator(selector).first();
  if (await locator.isVisible().catch(() => false)) await locator.fill(value);
}

async function uploadImages(
  page: Page,
  body: Locator,
  selector: string,
  triggerSelector: string,
  images: readonly DriverPublishInput['images'][number][],
  timeoutMs: number,
): Promise<void> {
  if (images.length === 0) return;
  const locator = page.locator(selector).first();
  if ((await locator.count()) > 0) {
    await setImageFiles(locator, images);
    return;
  }
  const trigger = page.locator(triggerSelector).first();
  if (!(await trigger.isVisible().catch(() => false))) {
    throw new PageDriverError(
      'PAGE_SIGNATURE_CHANGED',
      'Baijiahao image upload entry no longer matches the frozen page signature',
    );
  }
  let insertedCount = await body.locator('img').count();
  for (let offset = 0; offset < images.length;) {
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: timeoutMs }),
      trigger.click(),
    ]);
    const batch = fileChooser.isMultiple()
      ? images.slice(offset)
      : images.slice(offset, offset + 1);
    await fileChooser.setFiles(imageFilePayloads(batch));
    insertedCount += batch.length;
    await body
      .locator('img')
      .nth(insertedCount - 1)
      .waitFor({ state: 'attached', timeout: timeoutMs });
    offset += batch.length;
  }
}

async function setImageFiles(
  locator: Locator,
  images: readonly DriverPublishInput['images'][number][],
): Promise<void> {
  await locator.setInputFiles(imageFilePayloads(images));
}

function imageFilePayloads(
  images: readonly DriverPublishInput['images'][number][],
): Parameters<Locator['setInputFiles']>[0] {
  return images.map((image, index) => ({
    buffer: Buffer.from(image.body),
    mimeType: image.mimeType,
    name: `${image.role}-${index + 1}.${extension(image.mimeType)}`,
  }));
}

async function clickOptional(page: Page, selector: string): Promise<void> {
  const locator = page.locator(selector).first();
  if (await locator.isVisible().catch(() => false)) await locator.click();
}

async function checkOptional(page: Page, selector: string): Promise<void> {
  const locator = page.locator(selector).first();
  if (!(await locator.isVisible().catch(() => false))) return;
  const checkbox = locator.locator('input[type="checkbox"]').first();
  if ((await checkbox.count()) === 0 || !(await checkbox.isChecked())) await locator.click();
}

async function selectOptional(page: Page, selector: string, value: string): Promise<void> {
  const locator = page.locator(selector).first();
  if ((await locator.count()) === 0) return;
  const selected = await locator.selectOption({ label: value }).catch(() => []);
  if (selected.length === 0) await locator.selectOption(value).catch(() => undefined);
}

function extension(mimeType: DriverPublishInput['images'][number]['mimeType']): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  return mimeType.slice('image/'.length);
}

async function restoreStorageState(context: BrowserContext, json: string): Promise<void> {
  try {
    const state = JSON.parse(json) as { readonly cookies?: unknown; readonly origins?: unknown };
    if (Array.isArray(state.cookies)) {
      await context.addCookies(state.cookies as Parameters<BrowserContext['addCookies']>[0]);
    }
    if (Array.isArray(state.origins)) {
      const origins = state.origins.map(requireStoredOrigin);
      await context.addInitScript((storedOrigins) => {
        const browserGlobal = globalThis as unknown as {
          readonly localStorage: { setItem(name: string, value: string): void };
          readonly location: { readonly origin: string };
        };
        const current = storedOrigins.find(
          (entry) => entry.origin === browserGlobal.location.origin,
        );
        for (const item of current?.localStorage ?? []) {
          browserGlobal.localStorage.setItem(item.name, item.value);
        }
      }, origins);
    }
  } catch {
    throw new PageDriverError('AUTH_REQUIRED', 'Encrypted browser state is invalid');
  }
}

function requireStoredOrigin(value: unknown): {
  readonly localStorage: readonly { readonly name: string; readonly value: string }[];
  readonly origin: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError();
  const candidate = value as Readonly<Record<string, unknown>>;
  const origin = typeof candidate['origin'] === 'string' ? candidate['origin'] : '';
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new TypeError();
  if (!Array.isArray(candidate['localStorage'])) throw new TypeError();
  const localStorage = candidate['localStorage'].map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError();
    const entry = item as Readonly<Record<string, unknown>>;
    if (typeof entry['name'] !== 'string' || typeof entry['value'] !== 'string') {
      throw new TypeError();
    }
    return Object.freeze({ name: entry['name'], value: entry['value'] });
  });
  return Object.freeze({ localStorage: Object.freeze(localStorage), origin });
}

function extractExternalId(value: string | null): string | null {
  if (!value) return null;
  const match = /(?:id|article)[=/]([A-Za-z0-9_-]{4,240})/u.exec(value);
  return match?.[1] ?? null;
}

function normalizeUrl(value: string | null, base: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, base);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function remoteStatus(value: string): RemotePublication['status'] {
  if (/发布成功|已发布|published/iu.test(value)) return 'published';
  if (/未通过|失败|驳回|failed/iu.test(value)) return 'failed';
  if (/审核|处理中|processing/iu.test(value)) return 'processing';
  return 'unknown';
}
