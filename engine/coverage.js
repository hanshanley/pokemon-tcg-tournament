export const canonical = (value) =>
  String(value ?? '')
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
const nameKey = (value) => canonical(value).toLowerCase();
export const energyTypes = [
  'Grass',
  'Fire',
  'Water',
  'Lightning',
  'Psychic',
  'Fighting',
  'Darkness',
  'Metal',
];
export const isBasicEnergy = (card) =>
  card.supertype === 'Energy' && card.subtypes?.includes('Basic');
export function basicEnergyKind(card) {
  if (!isBasicEnergy(card)) return null;
  const name = nameKey(card.name).replace(/^basic /, '');
  return energyTypes.find((type) => `${type.toLowerCase()} energy` === name) ?? null;
}

export function deckCoverage(deck, snapshot, catalog, engine) {
  const sets = new Map(snapshot.sets.map((set) => [set.id, set]));
  const raw = new Map(snapshot.cards.map((card) => [card.id, card]));
  const index = new Map();
  for (const card of catalog) {
    const key = `${card.set.toUpperCase()}:${card.number.replace(/^0+/, '') || '0'}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(card);
  }
  const cards = deck.lines.map((line) => {
    const card = raw.get(line.card_id);
    if (!card) throw new Error(`Missing source printing ${line.card_id}`);
    const set = sets.get(card.set_id);
    const code = (set.ptcgoCode ?? set.id).toUpperCase();
    const number = card.number.replace(/^0+/, '') || '0';
    const names = new Set([nameKey(card.name)]);
    const kind = basicEnergyKind(card);
    if (kind) {
      names.add(nameKey(`${kind} Energy`));
      names.add(nameKey(`Basic ${kind} Energy`));
    }
    const candidates = (index.get(`${code}:${number}`) ?? []).filter((entry) =>
      names.has(nameKey(entry.name)),
    );
    const candidate = candidates.length === 1 ? candidates[0] : null;
    const errors = [];
    if (!candidate)
      errors.push(`${candidates.length} exact engine printings; no name-only substitution.`);
    else {
      errors.push(...candidate.blockers);
      if (card.supertype === 'Pokémon') {
        if (String(candidate.hp) !== String(card.hp))
          errors.push('Source and executable HP differ.');
        for (const [field, label] of [
          ['attacks', 'attack'],
          ['abilities', 'ability'],
        ]) {
          if (
            JSON.stringify((card[field] ?? []).map((entry) => nameKey(entry.name))) !==
            JSON.stringify(candidate[field].map((entry) => nameKey(entry.name)))
          ) {
            errors.push(`Source and executable ${label} lists differ.`);
          }
        }
      }
    }
    return {
      ...line,
      name: card.name,
      set_code: code,
      number,
      status: errors.length ? 'blocked' : 'mapped',
      errors,
      engine_full_name: candidate?.full_name ?? null,
      implementation_sources: candidate?.sources ?? [],
    };
  });
  return {
    ready:
      Boolean(cards.length) &&
      !deck.resolution_errors?.length &&
      cards.every((card) => card.status === 'mapped'),
    engine,
    cards,
    message:
      'Exact engine mappings are experimental implementation coverage, not judge certification.',
  };
}
