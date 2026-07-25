import { expect, test, type Page, type Route } from '@playwright/test';

// The webServer stack (playwright.config.ts) runs the real Pages Function
// against the local fixture server, so "/api/odds" here is genuine function
// output. Scenario tests reshape that JSON in-flight via route interception.

// Evaluated in the browser; the node-side tsconfig has no DOM lib.
declare const document: {
  scrollingElement: { scrollWidth: number; clientWidth: number } | null;
};

type OddsBody = {
  meetings: Array<{ sources: Record<string, Record<string, unknown>> }>;
};

async function mutateOdds(page: Page, mutate: (body: OddsBody) => void): Promise<void> {
  await page.route('**/api/odds', async (route: Route) => {
    const response = await route.fetch();
    const body = (await response.json()) as OddsBody;
    mutate(body);
    await route.fulfill({ response, json: body });
  });
}

test.describe('rendered page (all sources ok)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.meeting').first()).toBeVisible();
  });

  test('shows header meta, three meetings, and the consensus strip', async ({ page }) => {
    await expect(page.locator('#header-meta')).toContainText('Current policy rate: 2.25%');
    await expect(page.locator('#header-meta')).toContainText('Next decision:');

    const meetings = page.locator('.meeting');
    await expect(meetings).toHaveCount(3);
    await expect(meetings.nth(0)).toContainText('September 2, 2026');
    await expect(meetings.nth(1)).toContainText('October 28, 2026');
    await expect(meetings.nth(2)).toContainText('December 9, 2026');

    await expect(meetings.nth(0).locator('.meeting-sub')).toContainText(
      /Announcement at 09:45 ET, (today|in \d+ days?)/,
    );

    // September has all three sources: three shared-axis bars.
    await expect(meetings.nth(0).locator('.bar')).toHaveCount(3);
    await expect(meetings.nth(0).locator('.strip-source').first()).toHaveText('Kalshi');
    // Visible text percentages (color is never the only channel).
    await expect(meetings.nth(0).locator('.strip-hold').first()).toContainText('hold');
  });

  test('flags source disagreement with the two extreme values', async ({ page }) => {
    const flag = page.locator('.meeting').first().locator('.divergence-flag');
    await expect(flag).toBeVisible();
    await expect(flag).toContainText('sources disagree on');
    await expect(flag).toContainText('vs');
  });

  test('renders native per-source details with attribution and context', async ({ page }) => {
    const september = page.locator('.meeting').first();
    // Kalshi bps buckets, Polymarket buckets with liquidity, bocodds rate levels.
    await expect(september).toContainText('Maintains rate');
    await expect(september).toContainText('No Change');
    await expect(september).toContainText('liq');
    await expect(september).toContainText('2.50%');
    await expect(september).toContainText('Last updated July 25, 2026');
    await expect(september).toContainText('Data: BankofCanadaOdds.com');
  });

  test('shows a per-meeting unavailable note when a source has no market', async ({ page }) => {
    // The fixtures have no December Polymarket event.
    const december = page.locator('.meeting').nth(2);
    await expect(december).toContainText('Polymarket has no market for this meeting yet.');
    await expect(december.locator('.bar')).toHaveCount(2);
  });

  test('shows the schedule and the disclaimer', async ({ page }) => {
    await expect(page.locator('.schedule')).toContainText('December 9, 2026');
    await expect(page.locator('.about')).toContainText('not financial advice');
    await expect(page.locator('.about')).toContainText('not affiliated with the Bank of Canada');
  });
});

test.describe('degraded and disabled states', () => {
  test('stale source shows numbers with an as-of tag', async ({ page }) => {
    await mutateOdds(page, (body) => {
      const kalshi = body.meetings[0]!.sources['kalshi']!;
      kalshi['status'] = 'stale';
      kalshi['fetched_at'] = '2026-07-25T14:02:00.000Z';
    });
    await page.goto('/');
    const september = page.locator('.meeting').first();
    await expect(september.locator('.status-tag')).toContainText('as of');
    await expect(september.locator('.bar')).toHaveCount(3); // stale still draws its bar
  });

  test('degraded source keeps its link but shows no numbers', async ({ page }) => {
    await mutateOdds(page, (body) => {
      for (const meeting of body.meetings) {
        meeting.sources['bocodds'] = {
          status: 'degraded',
          url: 'https://bankofcanadaodds.com/',
          note: 'This source published numbers that failed validation, so they are not shown.',
        };
      }
    });
    await page.goto('/');
    const september = page.locator('.meeting').first();
    await expect(september).toContainText('failed validation');
    await expect(september.locator('.bar')).toHaveCount(2);
    await expect(
      september.locator('.source-detail a[href="https://bankofcanadaodds.com/"]').first(),
    ).toBeVisible();
  });

  test('disabled source shows its card with only the outbound link', async ({ page }) => {
    await mutateOdds(page, (body) => {
      for (const meeting of body.meetings) {
        meeting.sources['bocodds'] = {
          status: 'disabled',
          url: 'https://bankofcanadaodds.com/',
          note: 'This source is not shown until data permission is confirmed.',
        };
      }
    });
    await page.goto('/');
    const september = page.locator('.meeting').first();
    await expect(september).toContainText('not shown until data permission is confirmed');
    await expect(september.locator('.bar')).toHaveCount(2);
  });
});

test.describe('error state', () => {
  test('unreachable API shows a friendly error and keeps the static links', async ({ page }) => {
    await page.route('**/api/odds', (route) => route.abort());
    await page.goto('/');
    await expect(page.locator('#error')).toBeVisible();
    await expect(page.locator('#error')).toContainText("couldn't be loaded");
    await expect(page.locator('#error a[href="/"]')).toBeVisible(); // retry link
    await expect(page.locator('.links')).toContainText('BankofCanadaOdds.com');
    await expect(page.locator('#loading')).toBeHidden();
  });
});

test.describe('mobile', () => {
  test('no horizontal scroll at 375px wide @mobile', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.meeting').first()).toBeVisible();
    const overflow = await page.evaluate(() => {
      const el = document.scrollingElement!;
      return el.scrollWidth - el.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(page.locator('.meeting').first().locator('.bar').first()).toBeVisible();
  });
});
