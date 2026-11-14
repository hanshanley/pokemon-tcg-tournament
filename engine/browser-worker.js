import { catalog, runBattle } from './core.js';
import { deckCoverage } from './coverage.js';

const cards = catalog();
self.onmessage = ({ data }) => {
  const { id, mode, payload } = data;
  try {
    const result =
      mode === 'coverage'
        ? deckCoverage(payload.deck, payload.snapshot, cards, payload.engine)
        : mode === 'battle'
          ? runBattle(payload)
          : null;
    if (result === null) throw new Error('Unknown battle worker operation.');
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
};
