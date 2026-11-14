import { expect, test } from '@playwright/test';
import { unzipSync, strFromU8 } from 'fflate';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('real browser battle, complete ZIP, offline reproduction and persistent replay', async ({
  page,
}) => {
  const errors = [],
    backend = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.includes('/api/')) backend.push(request.url());
  });
  await page.goto('./#/battles');
  await page.getByRole('button', { name: 'New battle' }).click();
  await expect(page.getByRole('button', { name: 'Resolve complete battle' })).toBeEnabled({
    timeout: 30000,
  });
  await page.getByRole('button', { name: 'Resolve complete battle' }).click();
  await expect(page.locator('.metrics article').first().locator('strong')).not.toHaveText(
    /queued|running/,
    { timeout: 30000 },
  );
  await expect(page.getByText('completed', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Replay step')).toBeVisible();
  await page.getByLabel('Replay step').fill('0');
  await expect(page.locator('#replay-caption')).toContainText('Step 1 /');
  await page
    .getByLabel('Replay step')
    .fill(await page.getByLabel('Replay step').getAttribute('max'));
  await page.screenshot({ path: 'test-results/pages-battle-desktop.png', fullPage: true });
  const pending = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Complete battle' }).click();
  const download = await pending;
  const files = unzipSync(await readFile(await download.path()));
  expect(Object.keys(files)).toEqual(
    expect.arrayContaining([
      'battle.json',
      'input.json',
      'engine.cjs',
      'engine-manifest.json',
      'card-snapshot-1.json',
      'card-snapshot-2.json',
      'deck-1.txt',
      'deck-2.txt',
      'policy.json',
      'THIRD_PARTY_LICENSE.txt',
    ]),
  );
  const full = JSON.parse(strFromU8(files['battle.json']));
  expect(full.result.status).toBe('completed');
  expect(full.result.frames.length).toBe(full.result.steps);
  expect(full.result.frames.some((frame) => frame.action.type === 'ATTACK_ACTION')).toBe(true);
  expect(full.result.frames.some((frame) => frame.action.type === 'USE_ABILITY_ACTION')).toBe(true);
  expect(
    full.result.frames
      .filter((frame) => frame.action.type === 'PLAY_CARD_ACTION')
      .every((frame) => frame.action.card),
  ).toBe(true);
  expect(JSON.parse(strFromU8(files['card-snapshot-1.json'])).cards.length).toBeGreaterThan(20000);
  const scratch = await mkdtemp(path.join(tmpdir(), 'fieldnotes-rerun-'));
  try {
    const executable = path.join(scratch, 'engine.cjs');
    await writeFile(executable, files['engine.cjs']);
    const rerun = JSON.parse(
      execFileSync(process.execPath, [executable], {
        input: files['input.json'],
        timeout: 180000,
        maxBuffer: 30 * 1024 * 1024,
      }),
    );
    expect(rerun).toEqual(full.result);
  } finally {
    await rm(scratch, { recursive: true });
  }
  await page.reload();
  await expect(page.getByRole('link', { name: 'Complete battle' })).toBeVisible();
  await expect(page.getByLabel('Replay step')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/pages-battle-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
  expect(backend).toEqual([]);
});

test('Pages setup experiments retain full trials and mismatched decks remain blocked', async ({
  page,
}) => {
  await page.goto('./#/decks');
  await page.locator('.row-title').first().click();
  await expect(page.getByRole('heading', { name: 'Executable battle coverage' })).toBeVisible();
  await page.getByRole('button', { name: 'Run consistency experiment' }).click();
  await page.getByLabel('Accepted setups').fill('100');
  await page.getByRole('button', { name: 'Run reproducible experiment' }).click();
  await expect(page.getByRole('heading', { name: 'Frozen protocol' })).toBeVisible();
  const pending = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Complete experiment' }).click();
  const download = await pending;
  const files = unzipSync(await readFile(await download.path()));
  expect(JSON.parse(strFromU8(files['experiment.json'])).samples).toHaveLength(100);
  expect(JSON.parse(strFromU8(files['card-snapshot.json'])).cards.length).toBeGreaterThan(20000);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Frozen protocol' })).toBeVisible();
  await page.getByRole('link', { name: 'Battles', exact: true }).click();
  await page.getByRole('button', { name: 'New battle' }).click();
  const choices = page.getByLabel('Seat 1', { exact: true });
  await choices.selectOption({ index: 0 });
  await expect(page.getByRole('button', { name: 'Resolve complete battle' })).toBeDisabled();
  await expect(page.locator('#battle-coverage')).toContainText(/differ|exact engine printings/);
});

test('action-limited browser matches have no winner', async ({ page }) => {
  await page.goto('./#/battles');
  await page.getByRole('button', { name: 'New battle' }).click();
  await page.getByLabel('Action limit').fill('2');
  await page.getByRole('button', { name: 'Resolve complete battle' }).click();
  await expect(page.getByText('limited', { exact: true })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText('No winner', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('limited', { exact: true })).toBeVisible();
});
