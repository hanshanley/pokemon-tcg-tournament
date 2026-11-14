import { expect, test } from '@playwright/test';
import { importReferences, protocol, researchClient } from './helpers.js';

test('duplicate submissions are reserved during asynchronous preparation', async ({ page }) => {
  const ids = await importReferences(page);
  const results = await page.evaluate(
    async (body) =>
      Promise.allSettled([
        globalThis.research.staticAPI('/battles', body),
        globalThis.research.staticAPI('/battles', body),
      ]).then((outcomes) =>
        outcomes.map((result) => ({
          status: result.status,
          error: result.reason?.message,
          id: result.value?.id,
        })),
      ),
    protocol(ids),
  );
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((result) => result.status === 'rejected').error).toMatch(/preparing|running/);
  const count = await page.evaluate(
    async () => (await globalThis.research.staticAPI('/overview')).battles.length,
  );
  expect(count).toBe(1);
});

test('cloned tabs do not interrupt a live worker, but a closed owner is detected', async ({
  page,
}) => {
  const ids = await importReferences(page);
  let release;
  const paused = new Promise((resolve) => {
    release = resolve;
  });
  for (const id of ids)
    await page.evaluate((id) => globalThis.research.staticAPI(`/decks/${id}`), id);
  await page.route('**/battle-worker*.gz', async (route) => {
    await paused;
    await route.continue().catch(() => {});
  });
  const battle = await page.evaluate(
    (body) => globalThis.research.staticAPI('/battles', body),
    protocol(ids),
  );
  const popupPromise = page.waitForEvent('popup');
  await page.evaluate(() => window.open('./#/battles'));
  const popup = await popupPromise;
  try {
    await researchClient(popup);
    expect(
      await popup.evaluate(
        (id) => globalThis.research.staticAPI(`/battles/${id}`).then((b) => b.status),
        battle.id,
      ),
    ).toBe('running');
    await page.close();
    release();
    await popup.reload();
    await popup.evaluate(async () => {
      globalThis.research = await import('./static/audit-client.js');
    });
    expect(
      await popup.evaluate(
        (id) => globalThis.research.staticAPI(`/battles/${id}`).then((b) => b.status),
        battle.id,
      ),
    ).toBe('interrupted');
  } finally {
    release();
    await popup.close();
  }
});

test('worker failure leaves deck research usable and failed coverage can be retried', async ({
  page,
}) => {
  const ids = await importReferences(page);
  await page.route('**/battle-worker*.gz', (route) => route.abort());
  const blocked = await page.evaluate(async (id) => {
    const deck = await globalThis.research.staticAPI(`/decks/${id}`);
    const experiment = await globalThis.research.staticAPI('/experiments', {
      name: 'Setup without worker',
      deck_id: id,
      trials: 100,
      seed: 42,
      target_ids: [deck.lines[0].card_id],
      minimum: 1,
    });
    return { coverage: deck.battle_coverage, validation: deck.current_validation, experiment };
  }, ids[0]);
  expect(blocked.coverage.ready).toBe(false);
  expect(blocked.coverage.message).toMatch(/unavailable/);
  expect(blocked.validation.status).toBe('ready');
  expect(blocked.experiment.id).toBeTruthy();
  await page.unroute('**/battle-worker*.gz');
  expect(
    await page.evaluate(
      (id) => globalThis.research.staticAPI(`/decks/${id}`).then((d) => d.battle_coverage.ready),
      ids[0],
    ),
  ).toBe(true);
});

test('storage exhaustion is reported without an unhandled rejection or inferred winner', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const ids = await importReferences(page);
  const exhaustStorage = () => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (
        (this.name === 'artifacts' && String(args[0]).startsWith('battle:')) ||
        (this.name === 'records' && value.kind === 'battle' && value.value.status !== 'running')
      )
        throw new DOMException('Injected storage exhaustion', 'QuotaExceededError');
      return original.call(this, value, ...args);
    };
  };
  await page.addInitScript(exhaustStorage);
  await page.evaluate(exhaustStorage);
  const battle = await page.evaluate(
    (body) => globalThis.research.staticAPI('/battles', body),
    protocol(ids),
  );
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) => globalThis.research.staticAPI(`/battles/${id}`).then((b) => b.status),
          battle.id,
        ),
      { timeout: 30000 },
    )
    .toBe('failed');
  const failed = await page.evaluate(
    (id) => globalThis.research.staticAPI(`/battles/${id}`),
    battle.id,
  );
  expect(failed.reason).toMatch(/storage exhaustion/);
  expect(failed.winner).toBeUndefined();
  await page.reload();
  await researchClient(page);
  const recovered = await page.evaluate(
    (id) => globalThis.research.staticAPI(`/battles/${id}`),
    battle.id,
  );
  expect(recovered.status).toBe('interrupted');
  expect(recovered.winner).toBeUndefined();
  expect(errors).toEqual([]);
});
