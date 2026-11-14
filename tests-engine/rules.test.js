import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { deckCoverage } from '../engine/coverage.js';
import { secondFriday, assess, resolveDeck, setupExperiment } from '../web/research.js';

const require = createRequire(import.meta.url);
const {
  createStore,
  engineCard,
  rules,
  randomGenerator,
  withRandom,
  runBattle,
} = require('../data/engine/worker.cjs');
const target = { player: rules.PlayerType.BOTTOM_PLAYER, slot: rules.SlotType.ACTIVE, index: 0 };
const energy = () =>
  rules.manager.getCardByName(
    rules.manager
      .getAllCards()
      .find((card) => card.name === 'Psychic Energy' && card.superType === rules.SuperType.ENERGY)
      .fullName,
  );
function fixture(attacker = engineCard('SCR', '57'), defender = engineCard('SCR', '57')) {
  const store = createStore();
  store.state.phase = rules.GamePhase.PLAYER_TURN;
  store.state.turn = 3;
  store.state.players = [attacker, defender].map((card, index) => {
    const player = new rules.Player();
    player.id = index + 1;
    player.name = `Seat ${index + 1}`;
    player.active.cards = [card];
    player.active.hp = card.hp;
    player.bench = Array.from({ length: 5 }, () => new rules.PokemonCardList());
    player.prizes = Array.from({ length: 6 }, () => {
      const pile = new rules.CardList();
      pile.cards = [energy()];
      return pile;
    });
    player.deck.cards = Array.from({ length: 20 }, energy);
    return player;
  });
  return store;
}
function settle(store) {
  const arbiter = new rules.Arbiter();
  for (let count = 0; count < 30; count++) {
    const prompt = store.state.prompts.find((prompt) => prompt.result === undefined);
    if (!prompt) return;
    const action =
      arbiter.resolvePrompt(store.state, prompt) ??
      (prompt.constructor.name === 'WaitPrompt'
        ? new rules.ResolvePromptAction(prompt.id, null)
        : prompt.constructor.name === 'ChoosePokemonPrompt'
          ? new rules.ResolvePromptAction(prompt.id, [
              store.state.players.find((player) => player.id === prompt.playerId).active,
            ])
          : null);
    assert.ok(action, prompt.constructor.name);
    store.dispatch(action);
  }
  assert.fail('Prompt did not settle.');
}
function attach(player) {
  const cards = [energy(), energy()];
  player.active.cards.push(...cards);
  player.active.energies.cards = cards;
}

test('first-player attack and Supporter restrictions are enforced', () => {
  const store = fixture();
  store.state.turn = 1;
  const player = store.state.players[0];
  attach(player);
  assert.throws(() => store.dispatch(new rules.AttackAction(1, 'Tackle')));
  player.hand.cards = [engineCard('SVI', '189')];
  assert.throws(() => store.dispatch(new rules.PlayCardAction(1, 0, target)));
  assert.equal(player.hand.cards.length, 1);
});
test('one Energy attachment per turn, with the card actually moved', () => {
  const store = fixture(),
    player = store.state.players[0];
  player.hand.cards = [energy(), energy()];
  store.dispatch(new rules.PlayCardAction(1, 0, target));
  assert.equal(player.active.energies.cards.length, 1);
  assert.equal(player.hand.cards.length, 1);
  assert.throws(() => store.dispatch(new rules.PlayCardAction(1, 0, target)));
});
test('evolution is blocked on the turn a Pokémon enters play', () => {
  const fresh = fixture();
  fresh.state.players[0].active.pokemonPlayedTurn = fresh.state.turn;
  fresh.state.players[0].hand.cards = [engineCard('SCR', '58')];
  assert.throws(() => fresh.dispatch(new rules.PlayCardAction(1, 0, target)));
  const established = fixture();
  established.state.players[0].active.pokemonPlayedTurn = 1;
  established.state.players[0].hand.cards = [engineCard('SCR', '58')];
  established.dispatch(new rules.PlayCardAction(1, 0, target));
  assert.equal(established.state.players[0].active.getPokemonCard().name, 'Slowking');
});
test('attacks require Energy, apply weakness and resistance, then change turns', () => {
  assert.throws(() => fixture().dispatch(new rules.AttackAction(1, 'Tackle')));
  const store = fixture(),
    [player, opponent] = store.state.players;
  attach(player);
  // Psychic attacks hit Psychic weakness in this controlled board.
  opponent.active.getPokemonCard().weakness = [{ type: rules.CardType.PSYCHIC }];
  opponent.active.getPokemonCard().resistance = [];
  assert.doesNotThrow(() => store.dispatch(new rules.AttackAction(1, 'Tackle')), 'charged attack');
  settle(store);
  assert.equal(opponent.active.damage, 60);
  assert.equal(store.state.activePlayer, 1);
  const resistant = fixture();
  attach(resistant.state.players[0]);
  resistant.state.players[1].active.getPokemonCard().weakness = [];
  resistant.state.players[1].active.getPokemonCard().resistance = [
    { type: rules.CardType.PSYCHIC, value: -30 },
  ];
  assert.doesNotThrow(
    () => resistant.dispatch(new rules.AttackAction(1, 'Tackle')),
    'resistant attack',
  );
  settle(resistant);
  assert.equal(resistant.state.players[1].active.damage, 0);
});
test('Mew ex Restart draws to three and cannot be used twice in one turn', () => {
  const store = fixture(engineCard('MEW', '151'));
  store.dispatch(new rules.UseAbilityAction(1, 'Restart', target));
  settle(store);
  assert.equal(store.state.players[0].hand.cards.length, 3);
  store.state.players[0].hand.cards.pop();
  assert.throws(() => {
    store.dispatch(new rules.UseAbilityAction(1, 'Restart', target));
    settle(store);
  });
});
test('Potion resolves a real healing prompt and discards the Item', () => {
  const store = fixture(),
    player = store.state.players[0];
  player.active.damage = 50;
  player.hand.cards = [engineCard('SVI', '188')];
  store.dispatch(new rules.PlayCardAction(1, 0, target));
  settle(store);
  assert.equal(player.active.damage, 20);
  assert.equal(
    player.discard.cards.some((card) => card.name === 'Potion'),
    true,
  );
});
test('knockout takes a prize and no surviving Pokémon gives a natural result', () => {
  const store = fixture(),
    [player, opponent] = store.state.players;
  attach(player);
  opponent.active.damage = 60;
  store.dispatch(new rules.AttackAction(1, 'Tackle'));
  settle(store);
  assert.equal(store.state.phase, rules.GamePhase.FINISHED);
  assert.equal(store.state.winner, rules.GameWinner.PLAYER_1);
  assert.ok(opponent.discard.cards.some((card) => card.name === 'Slowpoke'));
});
test('drawing from an empty deck loses naturally', () => {
  const store = fixture();
  store.state.players[1].deck.cards = [];
  store.dispatch(new rules.PassTurnAction(1));
  settle(store);
  assert.equal(store.state.phase, rules.GamePhase.FINISHED);
  assert.equal(store.state.winner, rules.GameWinner.PLAYER_1);
});
test('seeded match limits never imply a winner and RNG restoration survives errors', () => {
  const cards = [engineCard('SCR', '57').fullName, ...Array(59).fill(energy().fullName)];
  const input = {
    seed: 42,
    decks: [
      { name: 'A', cards },
      { name: 'B', cards },
    ],
    max_actions: 2,
  };
  const first = runBattle(input);
  assert.equal(first.status, 'limited');
  assert.equal(first.winner, null);
  assert.deepEqual(runBattle(input), first);
  const prior = Math.random;
  assert.throws(() =>
    withRandom(randomGenerator(1), () => {
      throw new Error('test');
    }),
  );
  assert.equal(Math.random, prior);
  assert.throws(() => runBattle({ ...input, seed: -1 }));
  const shuffled = runBattle({ ...input, max_actions: 6 });
  assert.equal(shuffled.status, 'limited');
  const permutations = shuffled.frames.filter(
    (frame) => frame.action.prompt === 'ShuffleDeckPrompt',
  );
  assert.equal(permutations.length, 2);
  assert.ok(permutations.every((frame) => new Set(frame.action.result).size === 60));
});
test('exact printing coverage rejects missing, unfinished, and mismatched implementations', () => {
  const card = {
    id: 's-1',
    name: 'Example',
    number: '1',
    set_id: 's',
    supertype: 'Pokémon',
    hp: '80',
    attacks: [],
    abilities: [],
  };
  const snapshot = { sets: [{ id: 's', ptcgoCode: 'TST' }], cards: [card] };
  const deck = { lines: [{ card_id: card.id, count: 60 }], resolution_errors: [] };
  const mapped = {
    name: 'Example',
    set: 'TST',
    number: '1',
    hp: 80,
    attacks: [],
    abilities: [],
    blockers: [],
    sources: [],
    full_name: 'Example TST',
  };
  assert.equal(deckCoverage(deck, snapshot, [mapped], {}).ready, true);
  for (const candidate of [
    { ...mapped, set: 'OTHER' },
    { ...mapped, hp: 70 },
    { ...mapped, blockers: ['Unfinished source'] },
    { ...mapped, attacks: [{ name: 'Different attack' }] },
  ]) {
    assert.equal(deckCoverage(deck, snapshot, [candidate], {}).ready, false);
  }
});
test('browser dated legality and strict imports do not guess future eligibility', () => {
  assert.equal(secondFriday('2026-09-16'), '2026-09-25');
  const policy = {
    effective_from: '2026-04-10',
    reviewed_through: '2026-11-14',
    legal_marks: ['H', 'I', 'J'],
    set_overrides: {},
    handbook: 'reviewed-evidence',
  };
  const snapshot = {
    sets: [{ id: 's', name: 'Test', ptcgoCode: 'TST', releaseDate: '2026/11/06' }],
    cards: [
      {
        id: 's-1',
        name: 'Example',
        number: '1',
        set_id: 's',
        supertype: 'Pokémon',
        regulationMark: 'J',
      },
    ],
  };
  assert.equal(assess(snapshot, policy, '2026-11-14')[0].legality.status, 'waiting');
  assert.equal(assess(snapshot, policy, '2026-11-20')[0].legality.status, 'review');
  assert.equal(resolveDeck('4 Example OTHER 1', snapshot).lines.length, 0);
  assert.equal(resolveDeck('4 Example TST 1', snapshot).total, 4);
});
test('browser setup sampling is seeded and retains disjoint physical cards', () => {
  const snapshot = {
    cards: [
      { id: 'basic', supertype: 'Pokémon', subtypes: ['Basic'] },
      { id: 'energy', supertype: 'Energy' },
    ],
  };
  const deck = {
    lines: [
      { card_id: 'basic', count: 4 },
      { card_id: 'energy', count: 56 },
    ],
  };
  const result = setupExperiment(deck, snapshot, ['basic'], 100, 42, 1);
  assert.deepEqual(setupExperiment(deck, snapshot, ['basic'], 100, 42, 1).samples, result.samples);
  assert.equal(result.samples.length, 100);
  assert.ok(
    result.samples.every(
      (sample) =>
        sample.hand.includes('basic') && sample.hand.length === 7 && sample.prizes.length === 6,
    ),
  );
});
