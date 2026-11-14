import * as sets from '@engine/sets/index.ts';
import { randomGenerator } from '../web/random.js';
export { randomGenerator } from '../web/random.js';
import { CardManager } from '@engine/game/cards/card-manager.ts';
import { Card } from '@engine/game/store/card/card.ts';
import { Player } from '@engine/game/store/state/player.ts';
import { PokemonCardList } from '@engine/game/store/state/pokemon-card-list.ts';
import { CardList } from '@engine/game/store/state/card-list.ts';
import { Store } from '@engine/game/store/store.ts';
import { AddPlayerAction } from '@engine/game/store/actions/add-player-action.ts';
import {
  AttackAction,
  PassTurnAction,
  UseAbilityAction,
  RetreatAction,
} from '@engine/game/store/actions/game-actions.ts';
import {
  PlayCardAction,
  PlayerType,
  SlotType,
} from '@engine/game/store/actions/play-card-action.ts';
import { ResolvePromptAction } from '@engine/game/store/actions/resolve-prompt-action.ts';
import {
  CardType,
  SuperType,
  EnergyType,
  Stage,
  TrainerType,
  Format,
} from '@engine/game/store/card/card-types.ts';
import { GamePhase, GameWinner } from '@engine/game/store/state/state.ts';
import { Arbiter } from '@engine/game/core/arbiter.ts';
import { SimpleTacticsAi } from '@engine/simple-bot/simple-tactics-ai.ts';
import {
  allSimpleTactics,
  allPromptResolvers,
  defaultStateScores,
  defaultArbiterOptions,
} from '@engine/simple-bot/simple-bot-definitions.ts';

const manager = CardManager.getInstance();
const entries = Object.entries(sets)
  .filter(([, cards]) => Array.isArray(cards))
  .map(([key, cards]) => ({ key, cards }));
const duplicates = CardManager.validateAllSets(entries);
if (duplicates.length) throw new Error(duplicates.slice(0, 10).join('\n'));
for (const { cards } of entries) manager.defineSet(cards);

function sourceChain(card) {
  const chain = [];
  for (
    let constructor = card.constructor;
    constructor;
    constructor = Object.getPrototypeOf(constructor)
  ) {
    if (Object.hasOwn(constructor, 'fieldnotesSource')) chain.push(constructor.fieldnotesSource);
  }
  return chain;
}

function descriptor(card) {
  const sources = sourceChain(card);
  const blockers = [];
  if (!sources.length) blockers.push('No card implementation provenance.');
  if (sources.some((source) => source.incomplete))
    blockers.push('Upstream source contains an unfinished implementation marker.');
  const customHandler = card.reduceEffect !== Card.prototype.reduceEffect;
  if (!customHandler && card.powers.some((power) => !power.effect)) {
    blockers.push('Ability text has no executable card handler.');
  }
  if (!customHandler && card.attacks.some((attack) => attack.text && !attack.effect)) {
    blockers.push('Attack effect text has no executable card handler.');
  }
  return {
    full_name: card.fullName,
    name: card.name,
    set: card.set,
    number: card.setNumber,
    category: SuperType[card.superType],
    hp: card.hp ?? null,
    stage: Stage[card.stage] ?? null,
    energy_type: card.energyType === undefined ? null : EnergyType[card.energyType],
    trainer_type: card.trainerType === undefined ? null : TrainerType[card.trainerType],
    tags: card.tags,
    regulation_mark: card.regulationMark,
    types: (Array.isArray(card.cardType) ? card.cardType : [card.cardType])
      .filter((type) => type !== undefined)
      .map((type) => CardType[type]),
    attacks: card.attacks.map((attack) => ({
      name: attack.name,
      text: attack.text ?? '',
      damage: attack.damage,
      cost: attack.cost.map((type) => CardType[type]),
    })),
    abilities: card.powers.map((power) => ({ name: power.name, text: power.text ?? '' })),
    text: card.text ?? '',
    sources,
    blockers,
  };
}

export function catalog() {
  return manager.getAllCards().map(descriptor);
}

export function engineCard(set, number, name) {
  const matches = manager
    .getAllCards()
    .filter(
      (card) =>
        card.set === set && card.setNumber === String(number) && (!name || card.name === name),
    );
  if (matches.length !== 1)
    throw new Error(`Ambiguous engine printing: ${set} ${number} (${matches.length})`);
  return manager.getCardByName(matches[0].fullName);
}

export function withRandom(random, operation) {
  const previous = Math.random;
  Math.random = random;
  try {
    return operation();
  } finally {
    Math.random = previous;
  }
}

export function createStore() {
  const store = new Store({ onStateChange() {} });
  store.state.rules.firstTurnUseSupporter = false;
  store.state.rules.attackFirstTurn = false;
  store.state.gameSettings.rules = store.state.rules;
  store.state.gameSettings.format = Format.STANDARD;
  store.state.gameSettings.sandboxMode = false;
  return store;
}

const cardName = (card) => card?.fullName ?? null;
function slotView(slot) {
  const pokemon = slot.getPokemonCard();
  return {
    name: pokemon?.name ?? null,
    full_name: cardName(pokemon),
    hp: slot.hp || pokemon?.hp || 0,
    damage: slot.damage,
    cards: slot.cards.map(cardName),
    tools: slot.tools.map(cardName),
    conditions: [...slot.specialConditions],
    energy: slot.energies.cards.map(cardName),
    marker: encode(slot.marker.markers),
  };
}

export function viewState(state) {
  return {
    phase: GamePhase[state.phase],
    turn: state.turn,
    active_player: state.activePlayer,
    winner: state.winner,
    players: state.players.map((player) => ({
      id: player.id,
      name: player.name,
      active: slotView(player.active),
      bench: player.bench.map(slotView),
      hand: player.hand.cards.map(cardName),
      deck: player.deck.cards.map(cardName),
      prizes: player.prizes.map((prize) => prize.cards.map(cardName)),
      discard: player.discard.cards.map(cardName),
      lost_zone: player.lostzone.cards.map(cardName),
      stadium: player.stadium.cards.map(cardName),
      supporter: player.supporter.cards.map(cardName),
    })),
    prompts: state.prompts
      .filter((prompt) => prompt.result === undefined)
      .map((prompt) => ({
        id: prompt.id,
        player_id: prompt.playerId,
        type: prompt.constructor.name,
        message: prompt.message,
      })),
  };
}

function encode(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (value.fullName) return { full_name: value.fullName, id: value.id };
  if (Array.isArray(value)) return value.map(encode);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
}

function actionView(action, state) {
  const result = encode(action);
  const player = state.players.find((player) => player.id === (action.clientId ?? action.id));
  if (action instanceof PlayCardAction) {
    result.card = cardName(player?.hand.cards[action.handIndex]);
  }
  if (action instanceof ResolvePromptAction) {
    const prompt = state.prompts.find((prompt) => prompt.id === action.id);
    result.prompt = prompt?.constructor.name;
    result.player_id = prompt?.playerId;
  }
  return result;
}

export function runBattle(input) {
  if (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 4294967295) {
    throw new Error('A 32-bit unsigned integer seed is required.');
  }
  if (
    !Array.isArray(input.decks) ||
    input.decks.length !== 2 ||
    input.decks.some((deck) => !Array.isArray(deck.cards) || deck.cards.length !== 60)
  ) {
    throw new Error('Exactly two 60-card engine-resolved decks are required.');
  }
  const maxActions = input.max_actions ?? 1200;
  const maxTurns = input.max_turns ?? 200;
  if (
    !Number.isInteger(maxActions) ||
    maxActions < 2 ||
    maxActions > 5000 ||
    !Number.isInteger(maxTurns) ||
    maxTurns < 1 ||
    maxTurns > 500
  ) {
    throw new Error('Invalid battle limits.');
  }
  const random = randomGenerator(input.seed);
  const policyRandom = randomGenerator((input.seed ^ 0x9e3779b9) >>> 0);
  const store = createStore();
  const arbiter = new Arbiter();
  const options = {
    tactics: allSimpleTactics,
    promptResolvers: allPromptResolvers,
    scores: defaultStateScores,
    arbiter: defaultArbiterOptions,
  };
  const bots = input.decks.map(
    (deck, index) => new SimpleTacticsAi({ id: index + 1, name: deck.name }, options, deck.cards),
  );
  const frames = [];
  let logCount = 0;
  let firstPlayer = null;
  const dispatch = (action) => {
    if (action instanceof ResolvePromptAction) {
      const prompt = store.state.prompts.find((prompt) => prompt.id === action.id);
      if (!prompt || !prompt.validate(action.result, store.state)) {
        throw new Error(`Baseline policy returned an invalid ${prompt?.constructor.name} result.`);
      }
    }
    const decision = actionView(action, store.state);
    withRandom(random, () => store.dispatch(action));
    const state = store.state;
    if (firstPlayer === null && state.phase === GamePhase.PLAYER_TURN)
      firstPlayer = state.activePlayer;
    frames.push({
      step: frames.length,
      action: decision,
      state: viewState(state),
      logs: state.logs.slice(logCount).map((log) => {
        const recorded = encode(log);
        if (recorded.params) delete recorded.params.timestamp;
        return recorded;
      }),
    });
    logCount = state.logs.length;
  };
  dispatch(new AddPlayerAction(1, input.decks[0].name, input.decks[0].cards));
  dispatch(new AddPlayerAction(2, input.decks[1].name, input.decks[1].cards));
  if (store.state.players.length !== 2) throw new Error('Engine rejected a deck before setup.');
  let status = 'limited';
  let reason = 'Action or turn limit reached; no winner is inferred.';
  try {
    while (frames.length < maxActions && store.state.turn <= maxTurns) {
      const state = store.state;
      if (
        state.isSuddenDeath ||
        state.logs.some((log) => String(log.message).includes('SUDDEN_DEATH'))
      ) {
        status = 'blocked';
        reason =
          'Simultaneous win needs the 2026 tiebreaker rule; upstream sudden-death replay is not accepted.';
        break;
      }
      if (state.phase === GamePhase.FINISHED) {
        status = state.winner === GameWinner.NONE ? 'failed' : 'completed';
        reason =
          status === 'completed'
            ? 'Engine reached a natural game result.'
            : 'Engine ended without a game result.';
        break;
      }
      let action;
      for (const prompt of state.prompts.filter((prompt) => prompt.result === undefined)) {
        action = withRandom(random, () => arbiter.resolvePrompt(state, prompt));
        if (action) break;
      }
      if (!action) {
        const order = [state.activePlayer, 1 - state.activePlayer];
        action = withRandom(policyRandom, () => {
          for (const index of order) {
            const candidate = bots[index].decodeNextAction(state);
            if (candidate) return candidate;
          }
        });
      }
      if (!action) {
        status = 'blocked';
        reason = 'No baseline policy can resolve the pending action or prompt.';
        break;
      }
      dispatch(action);
    }
    if (store.state.phase === GamePhase.FINISHED && status === 'limited') {
      status = store.state.winner === GameWinner.NONE ? 'failed' : 'completed';
      reason =
        status === 'completed'
          ? 'Engine reached a natural game result.'
          : 'Engine ended without a game result.';
    }
  } catch (error) {
    status = 'failed';
    reason = `Executable effect or policy failed: ${error.message}`;
  }
  if (
    store.state.isSuddenDeath ||
    store.state.logs.some((log) => String(log.message).includes('SUDDEN_DEATH'))
  ) {
    status = 'blocked';
    reason =
      'Simultaneous win needs the 2026 tiebreaker rule; upstream sudden-death replay is not accepted.';
  }
  const winner =
    status === 'completed' &&
    [GameWinner.PLAYER_1, GameWinner.PLAYER_2].includes(store.state.winner)
      ? store.state.winner
      : null;
  return {
    status,
    reason,
    seed: input.seed,
    first_player: firstPlayer,
    winner,
    draw: status === 'completed' && store.state.winner === GameWinner.DRAW,
    turns: store.state.turn,
    steps: frames.length,
    frames,
    final_state: viewState(store.state),
    agent_policy: 'upstream-simple-tactics-v1',
    randomness:
      'mulberry32-v2 (32-bit wrapped); independent actual-game and policy streams; Fisher-Yates game shuffles',
    perspective: 'omniscient research replay; both hands and deck orders are visible',
    log_clock: 'Wall-clock log timestamps omitted; replay steps preserve ordering.',
  };
}

export const rules = {
  AddPlayerAction,
  AttackAction,
  PassTurnAction,
  UseAbilityAction,
  RetreatAction,
  PlayCardAction,
  PlayerType,
  SlotType,
  ResolvePromptAction,
  CardType,
  SuperType,
  EnergyType,
  Stage,
  TrainerType,
  GamePhase,
  GameWinner,
  manager,
  Player,
  PokemonCardList,
  CardList,
  Arbiter,
};
