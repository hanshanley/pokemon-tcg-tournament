import { expect, test } from '@playwright/test';
import { gzipSync, gunzipSync } from 'node:zlib';
import { researchClient } from './helpers.js';

const start = new Date();
start.setUTCHours(12, 0, 0, 0);
const day = start.toISOString().slice(0, 10);
const after = (milliseconds) => new Date(start.getTime() + milliseconds).toISOString();

test('today is never backdated and cached current legality expires in an open tab', async ({
  page,
}) => {
  await page.clock.install({ time: start });
  await page.route('**/records-*.gz', async (route) => {
    const response = await route.fetch();
    const seed = JSON.parse(gunzipSync(await response.body()));
    seed.as_of = day;
    seed.policy.verification = {
      ...seed.policy.verification,
      checked_at: after(-60000),
      valid_until: after(60000),
    };
    seed.policy.reviewed_through = day;
    await route.fulfill({ body: gzipSync(JSON.stringify(seed)) });
  });
  await researchClient(page);
  const initial = await page.evaluate(() => globalThis.research.staticAPI('/overview'));
  expect(initial.counts.legal).toBeGreaterThan(0);
  await page.clock.fastForward(120000);
  const expired = await page.evaluate(() => globalThis.research.staticAPI('/overview'));
  expect(expired.source_status.status).toBe('stale');
  expect(expired.counts.legal ?? 0).toBe(0);
  await expect(page.getByRole('status').filter({ hasText: 'verification expired' })).toBeVisible();
  await page.clock.fastForward(3 * 86400000);
  const health = await page.evaluate(() => globalThis.research.staticAPI('/health'));
  expect(health.default_as_of).toBe(after(3 * 86400000).slice(0, 10));
  await expect(page.locator('#as-of')).toHaveValue(health.default_as_of);
  const historical = await page.evaluate(
    (day) => globalThis.research.staticAPI(`/overview?as_of=${day}`),
    day,
  );
  expect(historical.counts.legal).toBeGreaterThan(0);
});

test('compatible new source publications refresh an open tab without losing its notebook', async ({
  page,
}) => {
  await page.clock.install({ time: start });
  let published = false;
  let seed;
  let snapshot;
  await page.route('**/data/manifest.json', async (route) => {
    const response = await route.fetch();
    const manifest = await response.json();
    if (published) {
      manifest.records = 'records-updated.gz';
      manifest.catalog = 'catalog-updated.gz';
    }
    await route.fulfill({ json: manifest });
  });
  await page.route('**/records-*.gz', async (route) => {
    if (route.request().url().endsWith('records-updated.gz')) {
      const updated = structuredClone(seed);
      updated.policy.verification.checked_at = after(240000);
      updated.policy.verification.valid_until = after(30 * 3600000 + 240000);
      for (const deck of updated.decks) deck.snapshot_id = 'updated-catalog';
      await route.fulfill({ body: gzipSync(JSON.stringify(updated)) });
    } else {
      const response = await route.fetch();
      seed = JSON.parse(gunzipSync(await response.body()));
      seed.policy.verification = {
        ...seed.policy.verification,
        checked_at: after(-60000),
        valid_until: after(30 * 3600000 - 60000),
      };
      await route.fulfill({ body: gzipSync(JSON.stringify(seed)) });
    }
  });
  await page.route('**/catalog-*.gz', async (route) => {
    if (route.request().url().endsWith('catalog-updated.gz')) {
      await route.fulfill({
        body: gzipSync(JSON.stringify({ ...snapshot, id: 'updated-catalog' })),
      });
    } else {
      const response = await route.fetch();
      snapshot = JSON.parse(gunzipSync(await response.body()));
      await route.fulfill({ response });
    }
  });
  await researchClient(page);
  const deck = await page.evaluate(() =>
    globalThis.research.staticAPI('/decks', {
      name: 'Keep my private notebook',
      text: '1 Unresolved Card UNKNOWN 1',
    }),
  );
  published = true;
  await page.clock.fastForward(301000);
  await page.evaluate(() => globalThis.research.staticAPI('/overview'));
  await expect
    .poll(() =>
      page.evaluate(async () => (await globalThis.research.staticAPI('/overview')).snapshot.id),
    )
    .toBe('updated-catalog');
  const result = await page.evaluate(() => globalThis.research.staticAPI('/overview'));
  expect(result.policy.verification.checked_at).toBe(after(240000));
  expect(result.decks.some((item) => item.id === deck.id)).toBe(true);
});
