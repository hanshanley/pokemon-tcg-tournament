import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomGenerator as setupRandom } from '../web/random.js';
import { readFileSync } from 'node:fs';
import { mechanicalErrors } from '../engine/coverage.js';

const mechanics = JSON.parse(
  readFileSync(new URL('./mechanics-cases.json', import.meta.url), 'utf8'),
);
test('mechanical coverage normalizes enum aliases and rejects meaningful discrepancies', () => {
  const { card, implementation, mismatches } = mechanics;
  assert.deepEqual(mechanicalErrors(card, implementation), []);
  for (const { change, error } of mismatches)
    assert.ok(
      mechanicalErrors(card, { ...implementation, ...change }).some((message) =>
        message.includes(error),
      ),
      error,
    );
  assert.deepEqual(
    mechanicalErrors(
      { ...card, attacks: [{ ...card.attacks[0], damage: '30+' }] },
      { ...implementation, attacks: [{ ...implementation.attacks[0], damage: 0 }] },
    ),
    [],
  );
  assert.ok(
    mechanicalErrors(
      { supertype: 'Trainer', subtypes: ['Item', 'Pokémon Tool'] },
      { category: 'TRAINER', trainer_type: 'ITEM' },
    ).length,
  );
  assert.ok(
    mechanicalErrors(
      { supertype: 'Energy', subtypes: ['Special'] },
      { category: 'ENERGY', energy_type: 'BASIC' },
    ).length,
  );
});

const { viewState, createStore, engineCard, rules, randomGenerator } = createRequire(
  import.meta.url,
)('../data/engine/worker.cjs');

test('recorded board states cannot change when live effects or conditions change', () => {
  const store = createStore();
  const player = new rules.Player();
  const card = engineCard('SCR', '57');
  player.active.cards = [card];
  player.active.marker.addMarker('FIRST', card);
  store.state.players = [player];
  const frame = viewState(store.state);
  const original = JSON.stringify(frame);
  player.active.specialConditions.push('Poisoned');
  player.active.marker.addMarker('LATER', card);
  card.hp = 999;
  assert.equal(JSON.stringify(frame), original);
});

test('long seeded runs retain 32-bit RNG behavior past five million draws', () => {
  const draws = 5000000;
  const precedingState = Number((BigInt(draws - 1) * 0x6d2b79f5n) & 0xffffffffn);
  const expected = setupRandom(precedingState)();
  for (const generator of [setupRandom, randomGenerator]) {
    const random = generator(0);
    let actual;
    for (let i = 0; i < draws; i++) actual = random();
    assert.equal(actual, expected);
  }
});
