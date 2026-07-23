import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { CORE_PAGES } from './core-pages';
import { installA11yApiMocks } from './mock-api';

const SERIOUS_IMPACTS = new Set(['critical', 'serious']);

test.describe('frozen 32-page accessibility acceptance', () => {
  for (const surface of CORE_PAGES) {
    test(`${surface.code} has no serious axe, keyboard, focus, label, or contrast issue`, async ({
      page,
    }) => {
      const apiAudit = await installA11yApiMocks(page);
      const response = await page.goto(surface.path, { waitUntil: 'domcontentloaded' });

      expect(response?.status(), `${surface.code} route must render`).toBeLessThan(400);
      await expect(page.locator('main#main-content')).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForTimeout(100);

      const audit = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      const severeViolations = audit.violations.filter((violation) =>
        SERIOUS_IMPACTS.has(violation.impact ?? ''),
      );
      expect(formatViolations(severeViolations), `${surface.code} axe serious items`).toEqual([]);

      await assertKeyboardAndFocus(page, surface.code);
      expect(apiAudit.writeRequests(), `${surface.code} must remain read-only`).toEqual([]);
    });
  }
});

async function assertKeyboardAndFocus(page: Page, pageCode: string): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Tab');

  const skipLink = page.getByRole('link', { name: '跳到主要内容' });
  await expect(skipLink, `${pageCode} skip link must be the first keyboard stop`).toBeFocused();
  await expect(skipLink).toBeVisible();
  await expect(page.locator('#main-content')).toHaveCount(1);

  const focusStops = new Set<string>();
  for (let index = 0; index < 6; index += 1) {
    const focused = page.locator(':focus');
    if ((await focused.count()) === 0) break;
    await expect(focused).toBeVisible();
    const state = await focused.evaluate((element) => {
      const html = element as HTMLElement;
      const style = getComputedStyle(html);
      return {
        disabled: html.matches(':disabled') || html.getAttribute('aria-disabled') === 'true',
        focusIndicator:
          (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0) ||
          style.boxShadow !== 'none',
        key: `${html.tagName}:${html.getAttribute('href') ?? html.getAttribute('name') ?? html.id}:${html.textContent?.trim().slice(0, 40) ?? ''}`,
        tagName: html.tagName,
      };
    });
    expect(state.disabled, `${pageCode} focus must not land on disabled controls`).toBe(false);
    expect(state.tagName, `${pageCode} focus must not fall back to body`).not.toBe('BODY');
    expect(state.focusIndicator, `${pageCode} focused control needs a visible indicator`).toBe(
      true,
    );
    focusStops.add(state.key);
    await page.keyboard.press('Tab');
  }
  expect(focusStops.size, `${pageCode} keyboard path must contain a page control`).toBeGreaterThan(
    0,
  );
}

function formatViolations(
  violations: readonly {
    readonly help: string;
    readonly id: string;
    readonly impact: string | null;
    readonly nodes: readonly { readonly target: readonly string[] }[];
  }[],
): string[] {
  return violations.map(
    (violation) =>
      `${violation.impact ?? 'unknown'}:${violation.id}:${violation.help}:${violation.nodes
        .flatMap((node) => node.target)
        .join(',')}`,
  );
}
