import { canonical, isBasicEnergy, basicEnergyKind } from '../engine/coverage.js';
import { randomGenerator } from './random.js';

const fields = [
  'name',
  'supertype',
  'subtypes',
  'hp',
  'types',
  'evolvesFrom',
  'evolvesTo',
  'rules',
  'abilities',
  'attacks',
  'weaknesses',
  'resistances',
  'retreatCost',
];
const normalize = (value) =>
  typeof value === 'string'
    ? canonical(value)
    : Array.isArray(value)
      ? value.map(normalize)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, normalize(value[key])]),
          )
        : value;
const identity = (card) =>
  JSON.stringify(normalize(Object.fromEntries(fields.map((key) => [key, card[key] ?? null]))));
const iso = (value) => value?.replaceAll('/', '-');
const result = (status, reason, as_of, extra = {}) => ({ status, reason, as_of, ...extra });

export function secondFriday(released) {
  const date = new Date(`${released}T00:00:00Z`);
  const days = (5 - date.getUTCDay() + 7) % 7 || 7;
  date.setUTCDate(date.getUTCDate() + days + 7);
  return date.toISOString().slice(0, 10);
}

export function assess(snapshot, policy, asOf) {
  const sets = new Map(snapshot.sets.map((set) => [set.id, set]));
  const within = asOf >= policy.effective_from && asOf <= policy.reviewed_through;
  const direct = (card) => {
    if (!within) return result('review', 'Date is outside the reviewed policy window.', asOf);
    if (card.legalities?.standard === 'Banned')
      return result('illegal', 'Source explicitly marks this printing banned.', asOf);
    if (!policy.legal_marks.includes(card.regulationMark))
      return result('review', 'Needs a functionally identical legal reprint.', asOf);
    const set = sets.get(card.set_id);
    const released = iso(set?.releaseDate);
    if (!released) return result('review', 'No release date evidence.', asOf);
    if (asOf < released)
      return result('unreleased', 'Printing has not been released.', asOf, { released });
    if (/promo/i.test(set.name ?? '') || /Promo/.test(card.rarity ?? '')) {
      return result('review', 'Promo needs its individual official legality date.', asOf);
    }
    const override = policy.set_overrides[set.id];
    const legalFrom = override?.legal_from ?? secondFriday(released);
    const extra = { legal_from: legalFrom, source: override?.source ?? policy.handbook };
    return asOf < legalFrom
      ? result('waiting', 'Tournament waiting period has not ended.', asOf, extra)
      : result(
          'legal',
          'Reviewed regulation mark and expansion waiting period satisfied.',
          asOf,
          extra,
        );
  };
  const decisions = new Map(snapshot.cards.map((card) => [card.id, direct(card)]));
  const reprints = new Map();
  if (within)
    for (const card of snapshot.cards) {
      if (decisions.get(card.id).status === 'legal') reprints.set(identity(card), card.id);
    }
  const rows = snapshot.cards.map((card) => {
    let decision = decisions.get(card.id);
    const set = sets.get(card.set_id) ?? {};
    if (within && !['legal', 'illegal', 'unreleased'].includes(decision.status)) {
      if (basicEnergyKind(card) && (!set.releaseDate || iso(set.releaseDate) <= asOf)) {
        decision = result('legal', 'Standard Basic Energy; no regulation mark required.', asOf, {
          source: policy.handbook,
        });
      } else {
        const match = reprints.get(identity(card));
        if (match && match !== card.id) {
          decision = result('legal', 'Exact structured rules match to a legal printing.', asOf, {
            reprint_id: match,
            source: policy.handbook,
          });
        }
      }
    }
    return {
      id: card.id,
      name: card.name,
      category: card.supertype,
      subtypes: card.subtypes ?? [],
      set_id: card.set_id,
      set_name: set.name ?? card.set_id,
      set_code: set.ptcgoCode ?? '',
      number: card.number,
      mark: card.regulationMark ?? null,
      hp: card.hp ?? null,
      legality: decision,
    };
  });
  rows.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  rows.sort((a, b) =>
    (iso(sets.get(b.set_id)?.releaseDate) ?? '').localeCompare(
      iso(sets.get(a.set_id)?.releaseDate) ?? '',
    ),
  );
  return rows;
}

export function resolveDeck(text, snapshot) {
  const sets = new Map(snapshot.sets.map((set) => [set.id, set]));
  const index = new Map();
  for (const card of snapshot.cards) {
    const key = `${(sets.get(card.set_id)?.ptcgoCode ?? card.set_id).toUpperCase()}:${card.number.replace(/^0+/, '') || '0'}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(card);
  }
  const errors = [],
    counts = new Map();
  for (const [position, value] of text.split('\n').entries()) {
    const line = value.trim();
    if (
      !line ||
      /^[#*]/.test(line) ||
      /^(?:Pok.mon|Trainer|Energy|Total Cards)\s*(?:[:\-\d]|Cards)/i.test(line)
    )
      continue;
    const match = line.match(/^(\d+)\s+(.+)\s+(\S+)\s+(\S+)$/);
    if (!match) {
      errors.push(`Line ${position + 1}: expected 'quantity name SET number'.`);
      continue;
    }
    const [, countText, name, code, number] = match;
    const count = Number(countText);
    if (count < 1 || count > 60) {
      errors.push(`Line ${position + 1}: quantity must be 1..60.`);
      continue;
    }
    const key = `${code.toUpperCase()}:${number.replace(/^0+/, '') || '0'}`;
    const candidates = (index.get(key) ?? []).filter((card) => {
      const kind = basicEnergyKind(card);
      return (
        canonical(card.name).toLowerCase() === canonical(name).toLowerCase() ||
        (kind &&
          [`${kind} Energy`, `Basic ${kind} Energy`].some(
            (alias) => alias.toLowerCase() === canonical(name).toLowerCase(),
          ))
      );
    });
    if (candidates.length !== 1) {
      errors.push(
        `Line ${position + 1}: cannot uniquely resolve '${name} ${code} ${number}' (${candidates.length} exact matches). No name-only fallback was used.`,
      );
      continue;
    }
    counts.set(candidates[0].id, (counts.get(candidates[0].id) ?? 0) + count);
  }
  return {
    lines: [...counts].map(([card_id, count]) => ({ card_id, count })),
    resolution_errors: errors,
    total: [...counts.values()].reduce((sum, count) => sum + count, 0),
  };
}

export function validateDeck(deck, snapshot, rows, asOf) {
  const cards = new Map(snapshot.cards.map((card) => [card.id, card]));
  const legality = new Map(rows.map((row) => [row.id, row.legality]));
  const errors = [...deck.resolution_errors],
    warnings = [],
    results = [],
    counts = new Map();
  let total = 0,
    basics = 0,
    aces = 0,
    radiants = 0;
  for (const line of deck.lines) {
    const card = cards.get(line.card_id);
    if (!card) {
      errors.push(`Unknown card ID ${line.card_id}`);
      continue;
    }
    const count = line.count;
    total += count;
    if (!isBasicEnergy(card))
      counts.set(canonical(card.name), (counts.get(canonical(card.name)) ?? 0) + count);
    if (card.supertype === 'Pokémon' && card.subtypes?.includes('Basic')) basics += count;
    if (card.subtypes?.includes('ACE SPEC')) aces += count;
    if (card.subtypes?.includes('Radiant')) radiants += count;
    const decision = legality.get(card.id);
    results.push({ ...line, ...decision });
    if (['illegal', 'waiting', 'unreleased'].includes(decision.status))
      errors.push(`${card.name} (${card.id}): ${decision.reason}`);
    else if (decision.status === 'review')
      warnings.push(`${card.name} (${card.id}): ${decision.reason}`);
  }
  if (total !== 60) errors.push(`Expected 60 cards; resolved ${total}.`);
  if (!basics) errors.push('At least one Basic Pokémon is required.');
  for (const [name, count] of counts)
    if (count > 4) errors.push(`${name}: ${count} copies exceeds the four-copy limit.`);
  if (aces > 1) errors.push('More than one ACE SPEC card.');
  if (radiants > 1) errors.push('More than one Radiant Pokémon.');
  return {
    status: errors.length ? 'invalid' : warnings.length ? 'review' : 'ready',
    as_of: asOf,
    total,
    basic_count: basics,
    errors,
    warnings,
    cards: results,
    scope: 'Card-data checks, not judge certification.',
  };
}

export function combination(n, k) {
  if (k < 0 || k > n) return 0;
  let value = 1;
  for (let i = 1; i <= k; i++) value = (value * (n - i + 1)) / i;
  return value;
}

function wilson(successes, trials) {
  const z = 1.959963984540054,
    p = successes / trials,
    d = 1 + (z * z) / trials;
  const mid = (p + (z * z) / (2 * trials)) / d;
  const margin = (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) / d;
  return [Math.max(0, mid - margin), Math.min(1, mid + margin)];
}

export function setupExperiment(deck, snapshot, targets, trials, seed, minimum) {
  if (
    !Number.isInteger(trials) ||
    trials < 100 ||
    trials > 20000 ||
    !Number.isInteger(seed) ||
    seed < 0 ||
    seed > 2147483647 ||
    !Number.isInteger(minimum) ||
    minimum < 1 ||
    minimum > 7
  )
    throw new Error('Invalid experiment bounds.');
  const cards = new Map(snapshot.cards.map((card) => [card.id, card]));
  const flat = deck.lines.flatMap((line) => Array(line.count).fill(line.card_id));
  const basic = new Set(
    flat.filter(
      (id) => cards.get(id).supertype === 'Pokémon' && cards.get(id).subtypes?.includes('Basic'),
    ),
  );
  const target = new Set(targets);
  if (
    flat.length !== 60 ||
    !basic.size ||
    !target.size ||
    [...target].some((id) => !flat.includes(id))
  )
    throw new Error('A resolved 60-card deck, Basic Pokémon, and present targets are required.');
  const rng = randomGenerator(seed);
  const counters = {
    opening_target: 0,
    target_prized: 0,
    target_by_first_draw: 0,
    any_mulligan: 0,
  };
  let mulligans = 0;
  const samples = [];
  for (let trial = 0; trial < trials; trial++) {
    let shuffled,
      hand,
      redraws = -1;
    do {
      shuffled = [...flat];
      for (let i = 59; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      hand = shuffled.slice(0, 7);
      redraws++;
    } while (!hand.some((id) => basic.has(id)));
    const prizes = shuffled.slice(7, 13),
      firstDraw = shuffled[13];
    const count = hand.filter((id) => target.has(id)).length;
    counters.opening_target += count >= minimum;
    counters.target_prized += prizes.some((id) => target.has(id));
    counters.target_by_first_draw += count + Number(target.has(firstDraw)) >= minimum;
    counters.any_mulligan += redraws > 0;
    mulligans += redraws;
    samples.push({ trial: trial + 1, hand, prizes, first_draw: firstDraw, mulligans: redraws });
  }
  const targetCount = flat.filter((id) => target.has(id)).length;
  let unconditional = 0;
  for (let n = minimum; n <= Math.min(targetCount, 7); n++)
    unconditional += combination(targetCount, n) * combination(60 - targetCount, 7 - n);
  return {
    kind: 'opening-hand-and-prizes',
    algorithm_version: 'browser-fisher-yates-mulberry32-v1',
    python_version: 'Browser JavaScript (different sampling algorithm)',
    created_at: new Date().toISOString(),
    trials,
    seed,
    minimum,
    target_ids: [...target],
    samples,
    metrics: Object.fromEntries(
      Object.entries(counters).map(([key, successes]) => [
        key,
        { successes, trials, probability: successes / trials, ci95: wilson(successes, trials) },
      ]),
    ),
    mean_mulligans: mulligans / trials,
    exact_initial_mulligan_probability:
      combination(60 - flat.filter((id) => basic.has(id)).length, 7) / combination(60, 7),
    unconditional_opening_target_probability: unconditional / combination(60, 7),
    assumptions: [
      'Uniform Fisher-Yates shuffles; redraw seven until a Basic Pokémon is present.',
      'Opening results are conditional on a valid hand; no opponent mulligan bonus cards.',
      'Six prizes, then one natural first draw; no card effects or gameplay in this setup-only experiment.',
      'Browser algorithm and seeds are reproducible separately from Python setup experiments.',
    ],
  };
}
