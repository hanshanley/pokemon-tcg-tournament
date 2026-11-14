import { buildSync } from 'esbuild';
import { readFileSync } from 'node:fs';

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
