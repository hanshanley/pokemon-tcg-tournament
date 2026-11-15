import { expect, test } from '@playwright/test';

test('inspect exact printings and run a complete reproducible experiment', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Card explorer', exact: true })).toBeVisible();
  await page.getByLabel('Search cards').fill('Research Basic');
  await page.getByRole('link', { name: 'Research Basic', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Legality evidence' })).toBeVisible();
  await page.getByRole('link', { name: 'Tournament decks', exact: true }).click();
  await page.getByRole('link', { name: 'Fixture research deck', exact: true }).click();
  await page.getByRole('button', { name: 'Run consistency experiment' }).click();
  await page.getByLabel('Target printing').selectOption('test-2');
  await page.getByLabel('Accepted setups').fill('1000');
  await page.getByRole('button', { name: 'Run reproducible experiment' }).click();
  await expect(page.getByRole('heading', { name: 'Frozen protocol' })).toBeVisible();
  await expect(page.getByText('Target in opening seven', { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Complete experiment' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^experiment-.+\.zip$/);
  expect(await download.failure()).toBeNull();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Frozen protocol' })).toBeVisible();
  await page.screenshot({ path: 'test-results/experiment-desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('mobile navigation, policy dates, and strict imports remain usable', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByLabel('Search cards')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/cards-mobile.png', fullPage: true });
  await page.getByRole('link', { name: 'Tournament decks', exact: true }).click();
  await page.getByRole('button', { name: 'Import a deck', exact: false }).click();
  await page.getByLabel('Deck name').fill('Unresolved import');
  await page.getByLabel('Original list').fill('60 Missing Card TST 99');
  await page.getByRole('button', { name: 'Validate & save deck' }).click();
  await expect(page.getByText(/cannot uniquely resolve/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run consistency experiment' })).toBeDisabled();
  await page.getByRole('link', { name: 'Sources and policy', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Conservative by design.' })).toBeVisible();
  const { policy } = await (await request.get('/api/health')).json();
  const outside = new Date(`${policy.reviewed_through}T00:00:00Z`);
  outside.setUTCDate(outside.getUTCDate() + 1);
  await page.getByLabel('Legality date').fill(outside.toISOString().slice(0, 10));
  await page.getByRole('link', { name: 'Card explorer', exact: true }).click();
  await expect(page.getByText('No printings match those filters.', { exact: true })).toBeVisible();
});

test('changing decks while targets load cannot restore stale target printings', async ({
  page,
  request,
}) => {
  const overview = await (await request.get('/api/overview')).json();
  const original = overview.decks.find((deck) => deck.name === 'Fixture research deck');
  const created = await request.post('/api/decks', {
    data: {
      name: 'Second fixture deck',
      text: '2 Research Basic TST 1\n4 Research Draw TST 2\n54 Fire Energy TST 3',
      as_of: overview.today,
    },
  });
  const second = await created.json();
  await page.route(`**/api/decks/${second.id}?*`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });
  await page.goto('/#/experiments');
  const slowResponse = page.waitForResponse((response) =>
    response.url().includes(`/api/decks/${second.id}?`),
  );
  await page.getByRole('button', { name: 'New experiment', exact: false }).click();
  await page.getByRole('combobox', { name: 'Deck', exact: true }).selectOption(original.id);
  await (await slowResponse).finished();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page.getByLabel('Target printing').locator('option').first()).toHaveText(
    /Research Basic.*4 copies/,
  );
  await expect(page.getByRole('button', { name: 'Run reproducible experiment' })).toBeEnabled();
});
