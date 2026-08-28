import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { buildDouyinDescriptionCaption } from '@geo-content-os/adapter-platforms/douyin/render';
import { chromium, type BrowserContext, type Locator, type Page, type Response } from 'playwright';

import type { DouyinBrowserConfig } from './config.js';
import type {
  DouyinPageDriver,
  DriverPublishInput,
  LoginStartResult,
  RemotePublication,
} from './types.js';

const SELECTORS = Object.freeze({
  aiGeneratedLegacy:
    'label:has-text("内容由AI生成"), label:has-text("AI生成"), [role="checkbox"]:has-text("AI生成")',
  authenticated:
    '[class*="user-info"], [class*="userInfo"], [class*="user-avatar"], [class*="userAvatar"], [data-e2e="user-avatar"]',
  captcha:
    'iframe[src*="captcha"], iframe[src*="verify"], [class*="captcha_verify"], [class*="secsdk-captcha"]',
  description:
    'textarea[placeholder*="作品描述"], textarea[placeholder*="添加作品描述"], div[contenteditable="true"][data-placeholder*="描述"], div[contenteditable="true"][data-placeholder*="简介"]',
  imageInput: 'input[type="file"][accept*="image"]',
  imagePreview:
    '[class*="imageItem"] img, [class*="image-item"] img, [class*="upload"] img[src^="blob:"], [class*="preview"] img[src^="blob:"]',
  original:
    'label:has-text("原创内容"), label:has-text("声明原创"), [role="checkbox"]:has-text("原创")',
  loginContainer: '#douyin_login_landing_flat_container, #douyin_login_comp_scan_code',
  qr: '#douyin_login_comp_scan_code img[aria-label="二维码"], #animate_qrcode_container img[aria-label="二维码"], img[aria-label="二维码"][src^="data:image/"]',
  title:
    'input[placeholder*="作品标题"], input[placeholder*="标题"], textarea[placeholder*="作品标题"]',
});

const AUTHENTICATED_MARKER_SETS = Object.freeze([
  Object.freeze(['发布作品', '作品管理']),
  Object.freeze(['作品发布', '内容管理']),
]);
const MANAGE_EMPTY_MARKERS = Object.freeze(['没有更多作品', '暂无作品', '暂无内容', '暂无数据']);
const PUBLICATION_ROW_SELECTOR =
  'tr, [class*="content-item"], [class*="contentItem"], [class*="work-card"], [class*="video-card"]';
const MANAGE_EMPTY_STABILITY_MS = 8_000;
const SECURITY_CHALLENGE_MARKER_SETS = Object.freeze([
  Object.freeze(['身份验证', '发送短信验证']),
  Object.freeze(['接收短信验证码']),
  Object.freeze(['使用原设备扫码']),
]);

interface WorkListEvidence {
  readonly externalId: string;
  readonly url: string;
}

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

export type PublishOperationStage =
  | 'capture_pre_submit'
  | 'clear_original_declaration'
  | 'fill_description'
  | 'fill_title'
  | 'load_editor'
  | 'mark_ai_generated'
  | 'persist_pre_submit'
  | 'submit'
  | 'upload_images'
  | 'verify_editor'
  | 'verify_pre_submit';

export class PageDriverOperationError extends Error {
  public constructor(
    public readonly stage: PublishOperationStage,
    cause: unknown,
  ) {
    super('Douyin browser operation failed', { cause });
    this.name = 'PageDriverOperationError';
  }
}

export class PlaywrightDouyinPageDriver implements DouyinPageDriver {
  private readonly contexts = new Map<string, BrowserContext>();
  private readonly pages = new Map<string, Page>();

  public constructor(private readonly config: DouyinBrowserConfig) {}

  public async startLogin(accountId: string, profilePath: string): Promise<LoginStartResult> {
    const page = await this.page(accountId, profilePath, null);
    await page.goto(this.config.loginUrl, { waitUntil: 'domcontentloaded' });
    await this.rejectCaptcha(page);
    const expiresAt = new Date(Date.now() + 180_000);
    if (await this.isAuthenticated(page)) return { expiresAt, qrPng: Buffer.alloc(0) };

    const qr = page.locator(SELECTORS.qr).first();
    if (!(await qr.isVisible().catch(() => false))) {
      const login = page.getByText(/登录|扫码登录/u).first();
      if (await login.isVisible().catch(() => false)) await login.click();
    }
    await qr.waitFor({ state: 'visible', timeout: this.config.navigationTimeoutMs });
    await page.waitForTimeout(800);
    return Object.freeze({ expiresAt, qrPng: await qr.screenshot({ type: 'png' }) });
  }

  public async waitForAuthentication(accountId: string, expiresAt: Date): Promise<boolean> {
    const page = this.pages.get(accountId);
    if (!page) return false;
    while (Date.now() < expiresAt.getTime()) {
      await this.rejectCaptcha(page);
      if (await this.isAuthenticated(page)) {
        await page.goto(this.config.editorUrl, { waitUntil: 'domcontentloaded' });
        return this.waitForAuthenticationResolution(page);
      }
      await page.waitForTimeout(Math.min(500, Math.max(1, expiresAt.getTime() - Date.now())));
    }
    return false;
  }

  public async verifyAuthenticated(
    accountId: string,
    profilePath: string,
    storageStateJson: string | null,
  ): Promise<boolean> {
    const page = await this.page(accountId, profilePath, storageStateJson);
    await page.goto(this.config.editorUrl, { waitUntil: 'domcontentloaded' });
    return this.waitForAuthenticationResolution(page);
  }

  public async exportStorageState(accountId: string): Promise<string> {
    const context = this.contexts.get(accountId);
    if (!context)
      throw new PageDriverError('AUTH_REQUIRED', 'Douyin browser context is unavailable');
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
      await this.requireImageNoteEditor(page);

      stage = 'upload_images';
      await uploadImages(page, input, this.config.navigationTimeoutMs);

      const title = page.locator(SELECTORS.title).first();
      const description = page.locator(SELECTORS.description).first();
      await title.waitFor({ state: 'visible', timeout: this.config.navigationTimeoutMs });
      await description.waitFor({ state: 'visible', timeout: this.config.navigationTimeoutMs });

      stage = 'fill_title';
      await title.fill(input.payload.title);
      stage = 'fill_description';
      await fillRichText(
        description,
        buildDouyinDescriptionCaption(input.payload.description, input.payload.topics),
      );
      stage = 'mark_ai_generated';
      await setAiGeneratedDeclaration(page, this.config.navigationTimeoutMs);
      stage = 'clear_original_declaration';
      await clearOptionalOriginalDeclaration(page);

      stage = 'verify_pre_submit';
      await this.rejectCaptcha(page);
      await verifyPreSubmit(page, title, description, input);
      stage = 'capture_pre_submit';
      const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
      stage = 'persist_pre_submit';
      await beforeSubmit(screenshot);

      stage = 'submit';
      const submit = publishButton(page);
      await submit.waitFor({ state: 'visible', timeout: this.config.navigationTimeoutMs });
      if (!(await submit.isEnabled())) {
        throw new PageDriverError('PAGE_SIGNATURE_CHANGED', 'Douyin publish button is disabled');
      }
      const preSubmitUrl = page.url();
      await submit.click();
      await waitForSubmitResult(
        page,
        preSubmitUrl,
        this.config.editorUrl,
        this.config.navigationTimeoutMs,
      );
      const currentUrl = page.url();
      return Object.freeze({
        externalId: input.contentFingerprint,
        reviewReason: null,
        status: 'processing',
        url: isEditorUrl(currentUrl, preSubmitUrl, this.config.editorUrl) ? null : currentUrl,
      });
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
    const workList = observeWorkListResponses(page, match);
    try {
      await page.goto(this.config.manageUrl, { waitUntil: 'domcontentloaded' });
      await this.rejectCaptcha(page);
      if (!(await this.waitForAuthenticationResolution(page))) {
        throw new PageDriverError('AUTH_REQUIRED', 'Douyin browser login is required');
      }
      await this.waitForManagePageReady(page, match.title);
      const observed = await workList.read();
      if (observed.length > 1) {
        throw new PageDriverError(
          'MULTIPLE_MATCHES',
          'Douyin content list contains multiple matching image notes',
        );
      }
      const fallback = observed[0] ?? null;
      const title = normalizeText(match.title);
      const candidates = await publicationCandidates(page, match.title);
      const matches: RemotePublication[] = [];
      for (const row of candidates) {
        const text = await row.innerText().catch(() => '');
        if (!(await hasExactTitle(row, title))) continue;
        const fingerprint = await rowAttribute(row, 'data-content-fingerprint');
        if (fingerprint && fingerprint !== match.contentFingerprint) continue;
        const submittedAt = await rowSubmittedAt(row, text);
        if (submittedAt && submittedAt.getTime() < match.submittedAfter.getTime()) continue;
        const link = row
          .locator('a[href*="creatorvideo"], a[href*="/note/"], a[href*="/video/"], a[href]')
          .first();
        const href = (await link.count()) > 0 ? await link.getAttribute('href') : null;
        const externalId =
          (await rowAttribute(row, 'data-external-id')) ??
          (await rowAttribute(row, 'data-content-id')) ??
          (await rowAttribute(row, 'data-item-id')) ??
          extractExternalId(href) ??
          fallback?.externalId ??
          null;
        if (!externalId) continue;
        const status = remoteStatus(text);
        matches.push(
          Object.freeze({
            externalId,
            reviewReason: failureReason(text),
            status,
            url: publicationUrl(href, externalId, this.config.manageUrl) ?? fallback?.url ?? null,
          }),
        );
      }
      const unique = uniquePublications(matches);
      if (unique.length > 1) {
        throw new PageDriverError(
          'MULTIPLE_MATCHES',
          'Douyin content list contains multiple matching image notes',
        );
      }
      return unique[0] ?? null;
    } finally {
      workList.stop();
    }
  }

  public async capture(accountId: string): Promise<Uint8Array> {
    const page = this.pages.get(accountId);
    if (!page) throw new PageDriverError('AUTH_REQUIRED', 'Douyin browser page is unavailable');
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
      viewport: { height: 960, width: 1440 },
    });
    if (storageStateJson) await restoreStorageState(context, storageStateJson);
    context.setDefaultTimeout(this.config.navigationTimeoutMs);
    const page = context.pages()[0] ?? (await context.newPage());
    this.contexts.set(accountId, context);
    this.pages.set(accountId, page);
    return page;
  }

  private async requireImageNoteEditor(page: Page): Promise<void> {
    const deadline = Date.now() + this.config.navigationTimeoutMs;
    const imageInput = page.locator(SELECTORS.imageInput).first();
    while (Date.now() < deadline) {
      if (await imageInput.isVisible().catch(() => false)) return;
      const tab = await uniqueVisibleExactText(page, ['发布图文', '上传图文']);
      if (tab) {
        await tab.click();
        await imageInput
          .waitFor({ state: 'visible', timeout: Math.max(1, deadline - Date.now()) })
          .catch(() => undefined);
        if (await imageInput.isVisible().catch(() => false)) return;
      }
      await page.waitForTimeout(Math.min(250, Math.max(1, deadline - Date.now())));
    }
    if (!(await this.isAuthenticated(page))) {
      throw new PageDriverError('AUTH_REQUIRED', 'Douyin browser login is required');
    }
    throw new PageDriverError(
      'PAGE_SIGNATURE_CHANGED',
      'Douyin image-note upload entry no longer matches the frozen page signature',
    );
  }

  private async isAuthenticated(page: Page): Promise<boolean> {
    if (
      await page
        .locator(SELECTORS.imageInput)
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      return true;
    }
    if (
      await page
        .locator(SELECTORS.authenticated)
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      return true;
    }
    if (
      await page
        .locator(SELECTORS.loginContainer)
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      return false;
    }
    if (page.url().includes('/login')) return false;
    const body = await page
      .locator('body')
      .innerText()
      .catch(() => '');
    return AUTHENTICATED_MARKER_SETS.some((markers) =>
      markers.every((marker) => body.includes(marker)),
    );
  }

  private async waitForAuthenticationResolution(page: Page): Promise<boolean> {
    const deadline = Date.now() + Math.min(this.config.navigationTimeoutMs, 10_000);
    while (Date.now() < deadline) {
      await this.rejectCaptcha(page);
      if (await this.isAuthenticated(page)) return true;
      if (
        await page
          .locator(SELECTORS.loginContainer)
          .first()
          .isVisible()
          .catch(() => false)
      ) {
        return false;
      }
      await page.waitForTimeout(Math.min(250, Math.max(1, deadline - Date.now())));
    }
    return false;
  }

  private async waitForManagePageReady(page: Page, expectedTitle: string): Promise<void> {
    const deadline = Date.now() + Math.min(this.config.navigationTimeoutMs, 15_000);
    const candidates = page.locator(PUBLICATION_ROW_SELECTOR);
    let emptySince: number | null = null;
    while (Date.now() < deadline) {
      await this.rejectCaptcha(page);
      if (await hasVisibleExpectedTitle(page, expectedTitle)) return;
      if (await hasReadyPublicationCandidate(candidates)) return;
      const body = await page
        .locator('body')
        .innerText()
        .catch(() => '');
      if (MANAGE_EMPTY_MARKERS.some((marker) => body.includes(marker))) {
        emptySince ??= Date.now();
        if (Date.now() - emptySince >= MANAGE_EMPTY_STABILITY_MS) return;
      } else {
        emptySince = null;
      }
      await page.waitForTimeout(Math.min(250, Math.max(1, deadline - Date.now())));
    }
    if (emptySince !== null) return;
    throw new PageDriverError(
      'PAGE_SIGNATURE_CHANGED',
      'Douyin content management page did not finish loading',
    );
  }

  private async rejectCaptcha(page: Page): Promise<void> {
    const visualChallenge = await page
      .locator(SELECTORS.captcha)
      .first()
      .isVisible()
      .catch(() => false);
    const smsIdentityChallenge = await hasVisibleSecurityChallenge(page);
    if (visualChallenge || smsIdentityChallenge) {
      throw new PageDriverError('CAPTCHA_REQUIRED', 'Douyin requires manual security verification');
    }
  }
}

async function uniqueVisibleExactText(
  page: Page,
  labels: readonly string[],
): Promise<Locator | null> {
  const matches: Locator[] = [];
  for (const label of labels) {
    const candidates = page.getByText(label, { exact: true });
    const count = Math.min(await candidates.count(), 20);
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible().catch(() => false)) matches.push(candidate);
    }
  }
  if (matches.length > 1) {
    throw new PageDriverError(
      'PAGE_SIGNATURE_CHANGED',
      'Douyin image-note tab has multiple visible exact matches',
    );
  }
  return matches[0] ?? null;
}

async function hasTextVisibleInViewport(page: Page, locator: Locator): Promise<boolean> {
  const viewport = page.viewportSize();
  if (!viewport) return false;
  const count = Math.min(await locator.count(), 20);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const box = await candidate.boundingBox().catch(() => null);
    if (
      box &&
      box.x < viewport.width &&
      box.y < viewport.height &&
      box.x + box.width > 0 &&
      box.y + box.height > 0
    ) {
      return true;
    }
  }
  return false;
}

async function hasVisibleSecurityChallenge(page: Page): Promise<boolean> {
  for (const markers of SECURITY_CHALLENGE_MARKER_SETS) {
    const matches = await Promise.all(
      markers.map((marker) =>
        hasTextVisibleInViewport(page, page.getByText(marker, { exact: false })),
      ),
    );
    if (matches.every(Boolean)) return true;
  }
  return false;
}

async function waitForVisibleSecurityChallenge(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hasVisibleSecurityChallenge(page)) return;
    await page.waitForTimeout(Math.min(200, Math.max(1, deadline - Date.now())));
  }
  throw new Error('Douyin security challenge was not shown');
}

async function uploadImages(
  page: Page,
  input: DriverPublishInput,
  timeoutMs: number,
): Promise<void> {
  if (input.images.length !== input.payload.image_asset_ids.length) {
    throw new PageDriverError('PAGE_SIGNATURE_CHANGED', 'Douyin image order is incomplete');
  }
  const fileInput = page.locator(SELECTORS.imageInput).first();
  await fileInput.waitFor({ state: 'attached', timeout: timeoutMs });
  await fileInput.setInputFiles(
    input.images.map((image, index) => ({
      buffer: Buffer.from(image.body),
      mimeType: image.mimeType,
      name: `${String(index + 1).padStart(2, '0')}-${image.assetId}.${extension(image.mimeType)}`,
    })),
  );
  const uploadTimeoutMs = Math.max(timeoutMs, 60_000);
  const uploaded = await Promise.any([
    page.waitForFunction(
      `(() => document.querySelectorAll(${JSON.stringify(SELECTORS.imagePreview)}).length >= ${input.images.length})()`,
      undefined,
      { timeout: uploadTimeoutMs },
    ),
    page
      .getByText(new RegExp(`已添加\\s*${input.images.length}\\s*张图片`, 'u'))
      .first()
      .waitFor({ state: 'visible', timeout: uploadTimeoutMs }),
  ])
    .then(() => true)
    .catch(() => false);
  if (!uploaded) {
    throw new PageDriverError(
      'PAGE_SIGNATURE_CHANGED',
      'Douyin did not confirm all image-note cards were uploaded',
    );
  }
}

async function fillRichText(locator: Locator, value: string): Promise<void> {
  const contentEditable = await locator.getAttribute('contenteditable');
  if (contentEditable === 'true') {
    await locator.click();
    await locator.press('ControlOrMeta+A');
    await locator.fill(value).catch(async () => locator.pressSequentially(value));
    return;
  }
  await locator.fill(value);
}

async function setCheckboxByLabel(
  locator: Locator,
  checked: boolean,
  fieldName: string,
): Promise<void> {
  const visible = await locator.isVisible().catch(() => false);
  if (!visible) {
    throw new PageDriverError(
      'PAGE_SIGNATURE_CHANGED',
      `Douyin ${fieldName} control was not found`,
    );
  }
  const input = locator.locator('input[type="checkbox"], input[type="radio"]').first();
  if (await input.count()) {
    await input.setChecked(checked);
    if ((await input.isChecked()) !== checked) {
      throw new PageDriverError(
        'PAGE_SIGNATURE_CHANGED',
        `Douyin ${fieldName} control did not preserve its value`,
      );
    }
    return;
  }
  const ariaChecked = await locator.getAttribute('aria-checked');
  if ((ariaChecked === 'true') !== checked) await locator.click();
  if ((await locator.getAttribute('aria-checked')) !== String(checked)) {
    throw new PageDriverError(
      'PAGE_SIGNATURE_CHANGED',
      `Douyin ${fieldName} control did not preserve its value`,
    );
  }
}

async function setAiGeneratedDeclaration(page: Page, timeoutMs: number): Promise<void> {
  const legacy = page.locator(SELECTORS.aiGeneratedLegacy).first();
  if (await legacy.isVisible().catch(() => false)) {
    await setCheckboxByLabel(legacy, true, 'AI declaration');
    return;
  }

  const placeholder = await uniqueVisibleExactText(page, ['请选择自主声明']);
  if (!placeholder) {
    throw new PageDriverError(
      'PAGE_SIGNATURE_CHANGED',
      'Douyin AI declaration control was not found',
    );
  }
  await placeholder.click();

  const option = page.getByText('内容由AI生成', { exact: true });
  await option.first().waitFor({ state: 'visible', timeout: timeoutMs });
  const visibleOption = await uniqueVisibleExactText(page, ['内容由AI生成']);
  if (!visibleOption) {
    throw new PageDriverError(
      'PAGE_SIGNATURE_CHANGED',
      'Douyin AI declaration option was not found',
    );
  }
  await selectRadioOption(page, visibleOption, '内容由AI生成');

  const dialog = page.getByRole('dialog').filter({ hasText: '内容由AI生成' }).first();
  const dialogVisible = await dialog.isVisible().catch(() => false);
  const fallbackScope = visibleOption.locator(
    'xpath=ancestor::*[.//button[normalize-space()="确认" or normalize-space()="确定"]][1]',
  );
  const confirmation = (dialogVisible ? dialog : fallbackScope)
    .getByRole('button', { name: /^(?:确认|确定)$/u })
    .first();
  if (!(await confirmation.isVisible().catch(() => false))) {
    throw new PageDriverError(
      'PAGE_SIGNATURE_CHANGED',
      'Douyin AI declaration confirmation was not found',
    );
  }
  await confirmation.click({ timeout: Math.min(timeoutMs, 10_000) });
  if (dialogVisible) {
    await dialog.waitFor({ state: 'hidden', timeout: Math.min(timeoutMs, 10_000) });
  }

  await placeholder
    .waitFor({ state: 'hidden', timeout: Math.min(timeoutMs, 10_000) })
    .catch(() => undefined);
  const selected = page.getByText('内容由AI生成', { exact: true });
  let selectedVisible = false;
  const selectedCount = Math.min(await selected.count(), 20);
  for (let index = 0; index < selectedCount; index += 1) {
    if (
      await selected
        .nth(index)
        .isVisible()
        .catch(() => false)
    )
      selectedVisible = true;
  }
  if (
    (await placeholder.isVisible().catch(() => false)) ||
    (await dialog.isVisible().catch(() => false)) ||
    !selectedVisible
  ) {
    throw new PageDriverError(
      'PAGE_SIGNATURE_CHANGED',
      'Douyin AI declaration control did not preserve its value',
    );
  }
}

async function selectRadioOption(page: Page, optionText: Locator, name: string): Promise<void> {
  const radios = page.getByRole('radio', { exact: true, name });
  const count = Math.min(await radios.count(), 20);
  const visible: Locator[] = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = radios.nth(index);
    if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
  }
  if (visible.length > 1) {
    throw new PageDriverError(
      'PAGE_SIGNATURE_CHANGED',
      'Douyin AI declaration has multiple visible radio controls',
    );
  }

  const radio = visible[0] ?? (count === 1 ? radios.first() : null);
  if (radio) {
    const type = await radio.getAttribute('type');
    if (type === 'radio') {
      await radio.check({ force: !(await radio.isVisible().catch(() => false)) });
      if (!(await radio.isChecked().catch(() => false))) {
        throw new PageDriverError(
          'PAGE_SIGNATURE_CHANGED',
          'Douyin AI declaration radio did not preserve its value',
        );
      }
      return;
    }
    if ((await radio.getAttribute('aria-checked')) !== 'true') await radio.click();
    if ((await radio.getAttribute('aria-checked')) !== 'true') {
      throw new PageDriverError(
        'PAGE_SIGNATURE_CHANGED',
        'Douyin AI declaration radio did not preserve its value',
      );
    }
    return;
  }

  const optionScope = optionText.locator(
    'xpath=ancestor::*[self::label or .//input[@type="radio"] or .//*[@role="radio"]][1]',
  );
  const nativeRadio = optionScope.locator('input[type="radio"]').first();
  if (await nativeRadio.count()) {
    await nativeRadio.check({ force: true });
    if (await nativeRadio.isChecked().catch(() => false)) return;
  }
  const customRadio = optionScope.locator('[role="radio"]').first();
  if (await customRadio.isVisible().catch(() => false)) {
    if ((await customRadio.getAttribute('aria-checked')) !== 'true') await customRadio.click();
    if ((await customRadio.getAttribute('aria-checked')) === 'true') return;
  }
  throw new PageDriverError(
    'PAGE_SIGNATURE_CHANGED',
    'Douyin AI declaration radio was not selectable',
  );
}

async function clearOptionalOriginalDeclaration(page: Page): Promise<void> {
  const locator = page.locator(SELECTORS.original).first();
  if (!(await locator.isVisible().catch(() => false))) return;
  const input = locator.locator('input[type="checkbox"], input[type="radio"]').first();
  if (await input.count()) {
    if (await input.isChecked().catch(() => false)) await input.setChecked(false);
    if (await input.isChecked().catch(() => false)) {
      throw new PageDriverError(
        'PAGE_SIGNATURE_CHANGED',
        'Douyin original-content declaration could not be cleared',
      );
    }
    return;
  }
  if ((await locator.getAttribute('aria-checked')) === 'true') await locator.click();
  if ((await locator.getAttribute('aria-checked')) === 'true') {
    throw new PageDriverError(
      'PAGE_SIGNATURE_CHANGED',
      'Douyin original-content declaration could not be cleared',
    );
  }
}

async function verifyPreSubmit(
  page: Page,
  title: Locator,
  description: Locator,
  input: DriverPublishInput,
): Promise<void> {
  const expectedCaption = buildDouyinDescriptionCaption(
    input.payload.description,
    input.payload.topics,
  );
  const actualTitle = normalizeText(
    (await currentFieldValue(page, title, input.payload.title)) ?? '',
  );
  const actualDescription = normalizeText(
    (await currentFieldValue(page, description, expectedCaption, true)) ?? '',
  );
  if (actualTitle !== normalizeText(input.payload.title)) {
    throw new PageDriverError('PAGE_SIGNATURE_CHANGED', 'Douyin editor did not preserve the title');
  }
  if (!actualDescription.includes(normalizeText(expectedCaption))) {
    throw new PageDriverError(
      'PAGE_SIGNATURE_CHANGED',
      'Douyin editor did not preserve the description and topics',
    );
  }
}

async function currentFieldValue(
  page: Page,
  preferred: Locator,
  expectedValue: string,
  allowContains = false,
): Promise<string | null> {
  if ((await preferred.count()) > 0 && (await preferred.isVisible().catch(() => false))) {
    const value = await fieldValue(preferred).catch(() => null);
    if (value !== null) return value;
  }

  const fields = page.locator('input, textarea, [contenteditable="true"]');
  const expected = normalizeText(expectedValue);
  const count = Math.min(await fields.count(), 200);
  for (let index = 0; index < count; index += 1) {
    const candidate = fields.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const value = await fieldValue(candidate).catch(() => '');
    const normalized = normalizeText(value);
    if (allowContains ? normalized.includes(expected) : normalized === expected) return value;
  }
  return null;
}

async function fieldValue(locator: Locator): Promise<string> {
  const tag = await locator.evaluate((element) => element.tagName.toLowerCase());
  return tag === 'input' || tag === 'textarea' ? locator.inputValue() : locator.innerText();
}

function publishButton(page: Page): Locator {
  return page
    .getByRole('button', { name: /发布|立即发布/u })
    .filter({ hasNotText: /定时/u })
    .last();
}

async function waitForSubmitResult(
  page: Page,
  preSubmitUrl: string,
  configuredEditorUrl: string,
  timeoutMs: number,
): Promise<void> {
  const success = page.getByText(/发布成功|提交成功|审核中|作品已发布/u).first();
  const failure = page.getByText(/发布失败|审核不通过|上传失败|发布内容失败/u).first();
  const result = await Promise.race([
    success.waitFor({ state: 'visible', timeout: timeoutMs }).then(() => 'success' as const),
    failure.waitFor({ state: 'visible', timeout: timeoutMs }).then(() => 'failed' as const),
    waitForVisibleSecurityChallenge(page, timeoutMs).then(() => 'security_challenge' as const),
    page
      .waitForURL((url) => !isEditorUrl(url.toString(), preSubmitUrl, configuredEditorUrl), {
        timeout: timeoutMs,
      })
      .then(() => 'navigation' as const),
  ]).catch(() => 'unknown' as const);
  if (result === 'failed') {
    throw new PageDriverError('PUBLISH_STATE_UNKNOWN', await failure.innerText());
  }
  if (result === 'security_challenge') {
    throw new PageDriverError(
      'CAPTCHA_REQUIRED',
      'Douyin requires manual identity verification before publication can finish',
    );
  }
  if (result === 'unknown') {
    throw new PageDriverError(
      'PUBLISH_STATE_UNKNOWN',
      'Douyin submission did not return a conclusive result',
    );
  }
}

async function publicationCandidates(page: Page, expectedTitle: string): Promise<Locator[]> {
  const result: Locator[] = [];
  const knownRows = page.locator(PUBLICATION_ROW_SELECTOR);
  const knownCount = Math.min(await knownRows.count(), 200);
  for (let index = 0; index < knownCount; index += 1) result.push(knownRows.nth(index));

  const exactTitles = page.getByText(expectedTitle, { exact: true });
  const titleCount = Math.min(await exactTitles.count(), 20);
  for (let index = 0; index < titleCount; index += 1) {
    const title = exactTitles.nth(index);
    if (!(await title.isVisible().catch(() => false))) continue;
    const statusRow = title.locator(
      'xpath=ancestor-or-self::*[(contains(., "已发布") or contains(., "审核中") or contains(., "发布中") or contains(., "不通过") or contains(., "发布失败")) and (self::a[@href] or descendant::a[@href])][1]',
    );
    if ((await statusRow.count()) > 0) {
      result.push(statusRow.first());
      continue;
    }
    const linkedRow = title.locator(
      'xpath=ancestor-or-self::*[self::a[@href] or descendant::a[@href]][1]',
    );
    if ((await linkedRow.count()) > 0) result.push(linkedRow.first());
  }
  return result;
}

async function hasVisibleExpectedTitle(page: Page, value: string): Promise<boolean> {
  const expected = normalizeText(value);
  const matches = page.locator('[data-title], [class*="title"], [class*="name"], a[href]');
  const count = Math.min(await matches.count(), 200);
  for (let index = 0; index < count; index += 1) {
    const candidate = matches.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const title =
      (await candidate.getAttribute('data-title').catch(() => null)) ??
      (await candidate.innerText().catch(() => ''));
    if (matchesExpectedTitle(title, expected)) return true;
  }
  return false;
}

function observeWorkListResponses(
  page: Page,
  match: { readonly submittedAfter: Date; readonly title: string },
): {
  readonly read: () => Promise<readonly WorkListEvidence[]>;
  readonly stop: () => void;
} {
  const pending: Promise<readonly WorkListEvidence[]>[] = [];
  const onResponse = (response: Response): void => {
    let url: URL;
    try {
      url = new URL(response.url());
    } catch {
      return;
    }
    if (!url.pathname.endsWith('/douyin/creator/pc/work_list')) return;
    pending.push(workListEvidence(response, match));
  };
  page.on('response', onResponse);
  return Object.freeze({
    read: async () => {
      const evidence = (await Promise.all(pending)).flat();
      return Object.freeze([...new Map(evidence.map((item) => [item.externalId, item])).values()]);
    },
    stop: () => page.off('response', onResponse),
  });
}

async function workListEvidence(
  response: Response,
  match: { readonly submittedAfter: Date; readonly title: string },
): Promise<readonly WorkListEvidence[]> {
  if (response.status() < 200 || response.status() >= 300) return [];
  const payload = await response.json().catch(() => null);
  if (payload === null) return [];
  const expected = normalizeText(match.title);
  const queue: unknown[] = [payload];
  const result: WorkListEvidence[] = [];
  while (queue.length > 0) {
    const value = queue.shift();
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    if (value === null || typeof value !== 'object') continue;
    const record = value as Readonly<Record<string, unknown>>;
    const description = firstString(record, ['desc', 'description', 'share_title']);
    const shareUrl = firstString(record, ['share_url']);
    const externalId =
      (typeof record['aweme_id'] === 'string' && /^\d{5,}$/u.test(record['aweme_id'])
        ? record['aweme_id']
        : null) ?? extractExternalId(shareUrl);
    const submittedAt = unixTimestamp(record['create_time']);
    if (
      externalId &&
      description &&
      matchesExpectedTitle(description, expected) &&
      (!submittedAt || submittedAt.getTime() >= match.submittedAfter.getTime())
    ) {
      result.push(
        Object.freeze({
          externalId,
          url: `https://www.douyin.com/note/${externalId}`,
        }),
      );
    }
    queue.push(
      ...Object.values(record).filter((item) => item !== null && typeof item === 'object'),
    );
  }
  return Object.freeze(result);
}

function firstString(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function unixTimestamp(value: unknown): Date | null {
  const seconds =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(seconds) || seconds < 1_000_000_000) return null;
  const result = new Date(seconds * 1_000);
  return Number.isNaN(result.getTime()) ? null : result;
}

async function hasReadyPublicationCandidate(candidates: Locator): Promise<boolean> {
  const count = Math.min(await candidates.count(), 20);
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    const text = normalizeText(await candidate.innerText().catch(() => ''));
    if (!text) continue;
    if ((await candidate.locator('a[href]').count()) > 0) return true;
    if (
      (await rowAttribute(candidate, 'data-external-id')) ||
      (await rowAttribute(candidate, 'data-content-id')) ||
      (await rowAttribute(candidate, 'data-item-id'))
    ) {
      return true;
    }
  }
  return false;
}

function isEditorUrl(value: string, preSubmitUrl: string, configuredEditorUrl: string): boolean {
  const current = new URL(value);
  const preSubmit = new URL(preSubmitUrl);
  const configured = new URL(configuredEditorUrl);
  return (
    current.origin === preSubmit.origin &&
    (current.pathname === preSubmit.pathname ||
      current.pathname === configured.pathname ||
      current.pathname.includes('/content/upload') ||
      current.pathname.includes('/content/post/image'))
  );
}

async function restoreStorageState(context: BrowserContext, json: string): Promise<void> {
  const state = JSON.parse(json) as {
    cookies?: Parameters<BrowserContext['addCookies']>[0];
    origins?: readonly {
      localStorage?: readonly { name: string; value: string }[];
      origin: string;
    }[];
  };
  if (state.cookies?.length) await context.addCookies(state.cookies);
  const localStorageByOrigin = Object.fromEntries(
    (state.origins ?? [])
      .filter((item) => item.origin && item.localStorage?.length)
      .map((item) => [item.origin, item.localStorage ?? []]),
  );
  if (Object.keys(localStorageByOrigin).length === 0) return;
  await context.addInitScript((valuesByOrigin) => {
    const browserGlobal = globalThis as unknown as {
      localStorage: { setItem(name: string, value: string): void };
      location: { origin: string };
    };
    for (const item of valuesByOrigin[browserGlobal.location.origin] ?? []) {
      browserGlobal.localStorage.setItem(item.name, item.value);
    }
  }, localStorageByOrigin);
}

function extractExternalId(value: string | null): string | null {
  if (!value) return null;
  return (
    /(?:item_id|itemId|id)=([0-9]{5,})/u.exec(value)?.[1] ??
    /\/(?:creatorvideo|video|note|content)\/([0-9]{5,})(?:[/?#]|$)/u.exec(value)?.[1] ??
    null
  );
}

function publicationUrl(href: string | null, externalId: string, manageUrl: string): string | null {
  if (!href) return null;
  const url = new URL(href, manageUrl);
  if (/\/creatorvideo\//u.test(url.pathname)) {
    return `https://www.douyin.com/note/${externalId}`;
  }
  return url.toString();
}

function remoteStatus(value: string): RemotePublication['status'] {
  if (/不通过|审核失败|发布失败|已下架/u.test(value)) return 'failed';
  if (/已发布|公开/u.test(value)) return 'published';
  return 'processing';
}

function uniquePublications(values: readonly RemotePublication[]): readonly RemotePublication[] {
  const result = new Map<string, RemotePublication>();
  for (const value of values) {
    const current = result.get(value.externalId);
    if (!current || remoteStatusRank(value.status) > remoteStatusRank(current.status)) {
      result.set(value.externalId, value);
    }
  }
  return [...result.values()];
}

function remoteStatusRank(value: RemotePublication['status']): number {
  if (value === 'failed') return 3;
  if (value === 'published') return 2;
  return 1;
}

function failureReason(value: string): string | null {
  return /不通过|审核失败|发布失败|已下架/u.test(value) ? value.slice(0, 500) : null;
}

function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .replaceAll('\u200B', '')
    .replaceAll('\u200C', '')
    .replaceAll('\u200D', '')
    .replaceAll('\u2060', '')
    .replaceAll('\uFEFF', '')
    .trim();
}

function matchesExpectedTitle(value: string, expected: string): boolean {
  const normalized = normalizeText(value);
  if (normalized === expected) return true;
  if (!normalized.startsWith(expected)) return false;
  return /^[。.!！?？:：]/u.test(normalized.slice(expected.length));
}

async function hasExactTitle(row: Locator, expected: string): Promise<boolean> {
  const rowTitle = await row.getAttribute('data-title').catch(() => null);
  if (rowTitle !== null) return matchesExpectedTitle(rowTitle, expected);
  const candidates = row.locator('[data-title], [class*="title"], [class*="name"], a[href]');
  const count = Math.min(await candidates.count(), 20);
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    const title =
      (await candidate.getAttribute('data-title').catch(() => null)) ??
      (await candidate.innerText().catch(() => ''));
    if (matchesExpectedTitle(title, expected)) return true;
  }
  return false;
}

async function rowAttribute(row: Locator, name: string): Promise<string | null> {
  const direct = await row.getAttribute(name).catch(() => null);
  if (direct) return direct.trim();
  const nested = row.locator(`[${name}]`);
  if ((await nested.count()) === 0) return null;
  return nested
    .first()
    .getAttribute(name)
    .then((value) => value?.trim() || null)
    .catch(() => null);
}

async function rowSubmittedAt(row: Locator, text: string): Promise<Date | null> {
  const explicit = await rowAttribute(row, 'data-submitted-at');
  return parseSubmittedAt(explicit ?? text);
}

function parseSubmittedAt(value: string): Date | null {
  const normalized = value.normalize('NFKC').trim();
  if (!normalized) return null;
  const chinese = /(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/u.exec(normalized);
  if (chinese) {
    const result = new Date(
      Number(chinese[1]),
      Number(chinese[2]) - 1,
      Number(chinese[3]),
      Number(chinese[4]),
      Number(chinese[5]),
    );
    if (!Number.isNaN(result.getTime())) return result;
  }
  const explicit = Date.parse(normalized);
  if (Number.isFinite(explicit) && /\d{4}/u.test(normalized)) return new Date(explicit);
  const today = /\u4eca\u5929\s*(\d{1,2}):(\d{2})/u.exec(normalized);
  if (today) {
    const result = new Date();
    result.setHours(Number(today[1]), Number(today[2]), 0, 0);
    return result;
  }
  const short = /(?:^|\D)(\d{1,2})[-/]?(\d{1,2})\s+(\d{1,2}):(\d{2})(?:\D|$)/u.exec(normalized);
  if (!short) return null;
  const result = new Date();
  result.setMonth(Number(short[1]) - 1, Number(short[2]));
  result.setHours(Number(short[3]), Number(short[4]), 0, 0);
  return Number.isNaN(result.getTime()) ? null : result;
}

function extension(mimeType: DriverPublishInput['images'][number]['mimeType']): string {
  return mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice('image/'.length);
}
