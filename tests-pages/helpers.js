import { buildSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { assess } from '../web/research.js';

const client = buildSync({
  entryPoints: ['web/static-client.js'],
  bundle: true,
  format: 'esm',
  write: false,
}).outputFiles[0].text;
const referenceDecks = JSON.parse(readFileSync('tests-pages/reference-decks.json', 'utf8'));

export async function researchClient(page) {
  await page.route('**/static/audit-client.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: client }),
  );
  await page.goto('./#/battles');
  await page.evaluate(async () => {
    globalThis.research = await import('./static/audit-client.js');
    await globalThis.research.staticAPI('/health');
  });
}

export async function importReferences(page) {
  await page.clock.install({ time: new Date('2026-11-14T12:00:00Z') });
  await page.route('**/records-*.gz', async (route) => {
    const response = await route.fetch();
    const seed = JSON.parse(gunzipSync(await response.body()));
    const manifest = JSON.parse(readFileSync('dist/data/manifest.json', 'utf8'));
    const snapshot = JSON.parse(gunzipSync(readFileSync(`dist/data/${manifest.catalog}`)));
    seed.policy = {
      ...seed.policy,
      id: 'test-only-frozen-2026-reference-format',
      effective_from: '2026-04-10',
      reviewed_through: '2026-11-14',
      legal_marks: ['H', 'I', 'J'],
    };
    delete seed.policy.verification;
    seed.as_of = '2026-11-14';
    seed.card_rows = assess(snapshot, seed.policy, seed.as_of);
    await route.fulfill({ body: gzipSync(JSON.stringify(seed)) });
  });
  await researchClient(page);
  return page.evaluate(async (decks) => {
    const saved = [];
    for (const deck of decks) saved.push(await globalThis.research.staticAPI('/decks', deck));
    return saved.map((deck) => deck.id);
  }, referenceDecks);
}

export const protocol = (ids) => ({
  name: 'Audited reference battle',
  deck_ids: ids,
  seed: 42,
  max_actions: 2,
  max_turns: 200,
});
