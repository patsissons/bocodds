import { readFileSync } from 'node:fs';
import { expect, test, type Page, type Route } from '@playwright/test';

// The webServer stack (playwright.config.ts) runs the real Pages Function
// against the local fixture server, so "/api/odds" here is genuine function
// output. Scenario tests reshape that JSON in-flight via route interception.

// Evaluated in the browser; the node-side tsconfig has no DOM lib.
declare const document: {
  scrollingElement: { scrollWidth: number; clientWidth: number } | null;
};
declare const navigator: {
  clipboard: { readText(): Promise<string> };
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
    // bocodds rate levels carry their bps change vs the current 2.25% rate.
    await expect(september).toContainText('+25 bps');
    await expect(september).toContainText('no change');
    await expect(september).toContainText('Last updated July 25, 2026');
    await expect(september).toContainText('Data: BankofCanadaOdds.com');
  });

  test('shows a per-meeting unavailable note when a source has no market', async ({ page }) => {
    // The fixtures have no December Polymarket event.
    const december = page.locator('.meeting').nth(2);
    await expect(december).toContainText('Polymarket has no market for this meeting yet.');
    await expect(december.locator('.bar')).toHaveCount(2);
  });

  test('share row copies the link and the embed code', async ({ page }) => {
    // Selected via data-share, not accessible name — the label flips to
    // "Copied ✓" on click, which would defeat a name-based locator.
    const copyLink = page.locator('[data-share="link"]');
    const copyEmbed = page.locator('[data-share="embed-code"]');
    await expect(copyLink).toHaveText('Copy link');

    await copyEmbed.click();
    await expect(copyEmbed).toHaveText('Copied ✓');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('<iframe src=');
    expect(copied).toContain('/embed');
    await expect(copyEmbed).toHaveText('Copy embed code'); // label restores
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

test.describe('dynamic OG meta', () => {
  test('serves rewritten title and meta once a snapshot exists', async ({ request }) => {
    await request.get('/api/odds'); // populate KV so / has data to rewrite with
    const response = await request.get('/');
    const html = await response.text();
    expect(html).toMatch(/<title>BoC Rate Odds — Sep 2: \d+% (cut|hold|hike)<\/title>/);
    expect(html).toMatch(
      /property="og:description" content="Market-implied odds for the September 2, 2026 Bank of Canada decision:/,
    );
    expect(html).toMatch(/property="og:image" content="[^"]*\/og\.png\?v=\d+"/);
    expect(html).toMatch(/name="twitter:title" content="BoC Rate Odds — Sep 2:/);
  });

  test('renders a dynamic og.png once a snapshot exists', async ({ request }) => {
    await request.get('/api/odds');
    const response = await request.get('/og.png');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toBe('image/png');
    const body = await response.body();
    expect(body.length).toBeGreaterThan(10_000);
    // A real render differs from the committed static fallback.
    const staticCard = readFileSync('public/og.png');
    expect(body.equals(staticCard)).toBe(false);
  });
});

test.describe('embed page', () => {
  test('renders the compact card for the next meeting', async ({ page }) => {
    await page.goto('/embed');
    await expect(page.locator('.embed-heading')).toContainText('September 2');
    await expect(page.locator('.embed-heading')).toContainText(/in \d+ days?|today/);
    await expect(page.locator('.bar')).toHaveCount(3);
    await expect(page.locator('.embed-footer a')).toHaveText('bocodds.com');
  });

  test('selects a meeting with ?meeting=', async ({ page }) => {
    await page.goto('/embed?meeting=2026-12-09');
    await expect(page.locator('.embed-heading')).toContainText('December 9');
    // The fixtures have no December Polymarket market.
    await expect(page.locator('.bar')).toHaveCount(2);
  });

  test('fits a narrow iframe without horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 220 });
    await page.goto('/embed');
    await expect(page.locator('.bar').first()).toBeVisible();
    const overflow = await page.evaluate(() => {
      const el = document.scrollingElement!;
      return el.scrollWidth - el.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('unreachable API keeps the outbound link', async ({ page }) => {
    await page.route('**/api/odds', (route) => route.abort());
    await page.goto('/embed');
    await expect(page.locator('.embed-error')).toContainText('unavailable');
    await expect(page.locator('.embed-footer a')).toBeVisible();
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
