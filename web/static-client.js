import { gunzipSync, zipSync, strToU8 } from 'fflate';
import {
  assess,
  resolveDeck,
  validateDeck,
  setupExperiment,
  policyWindow,
  sourceStatus,
} from './research.js';

const manifestURL = new URL('../data/manifest.json', import.meta.url);
let contextPromise;
let battleBusy = false;
const volatileFailures = new Map();
const documentOwner = crypto.randomUUID();
let leasePromise;
async function ownerLease() {
  if (!navigator.locks) return;
  leasePromise ??= new Promise((resolve, reject) => {
    navigator.locks
      .request(`fieldnotes-owner:${documentOwner}`, () => {
        resolve();
        return new Promise(() => {});
      })
      .catch(reject);
  });
  await leasePromise;
}
const request = (url, options = {}) =>
  fetch(url, { ...options, signal: AbortSignal.timeout(180000) });
const now = () => new Date().toISOString();
const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
export async function fingerprint(value) {
  const bytes = typeof value === 'string' ? strToU8(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
async function bytes(url) {
  const response = await request(url);
  if (!response.ok)
    throw new Error(`Published asset unavailable (${response.status}); reload the site.`);
  const raw = new Uint8Array(await response.arrayBuffer());
  return String(url).endsWith('.gz') ? gunzipSync(raw) : raw;
}
async function jsonAsset(url) {
  return JSON.parse(new TextDecoder().decode(await bytes(url)));
}
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('fieldnotes-tournament', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('records', { keyPath: 'key' });
      request.result.createObjectStore('artifacts');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new Error('Browser storage is unavailable; saved research requires IndexedDB.'));
  });
}
function operation(db, store, mode, action) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = action(transaction.objectStore(store));
    let result;
    request.onsuccess = () => {
      result = request.result;
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = transaction.onabort = () =>
      reject(
        transaction.error ?? new Error('Browser storage failed. Export results or free storage.'),
      );
  });
}
async function put(db, kind, value) {
  const result = {
    ...value,
    id: value.id ?? crypto.randomUUID(),
    created_at: value.created_at ?? now(),
  };
  await operation(db, 'records', 'readwrite', (store) =>
    store.put({ key: `${kind}:${result.id}`, kind, value: result }),
  );
  return result;
}
async function list(db, kind) {
  return (await operation(db, 'records', 'readonly', (store) => store.getAll()))
    .filter((record) => record.kind === kind)
    .map((record) => record.value)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}
const artifact = (db, key, value) =>
  operation(db, 'artifacts', value === undefined ? 'readonly' : 'readwrite', (store) =>
    value === undefined ? store.get(key) : store.put(value, key),
  );

async function boot() {
  const [response, db] = await Promise.all([
    request(manifestURL, { cache: 'no-store' }),
    openDatabase(),
  ]);
  if (!response.ok) throw new Error('Published source manifest is unavailable.');
  const manifest = await response.json();
  const [snapshot, seed] = await Promise.all([
    jsonAsset(new URL(manifest.catalog, manifestURL)),
    jsonAsset(new URL(manifest.records, manifestURL)),
  ]);
  await ownerLease();
  const held = navigator.locks
    ? new Set((await navigator.locks.query()).held.map((lock) => lock.name))
    : null;
  for (const battle of await list(db, 'battle')) {
    if (
      ['queued', 'running'].includes(battle.status) &&
      (held
        ? !held.has(`fieldnotes-owner:${battle.owner}`)
        : Date.now() - Date.parse(battle.updated_at ?? battle.created_at) > 300000)
    ) {
      const interrupted = {
        ...battle,
        status: 'interrupted',
        reason: 'No live browser worker could be confirmed; no result is inferred.',
      };
      volatileFailures.set(battle.id, interrupted);
      await put(db, 'battle', interrupted).catch(() => {});
    }
  }
  return {
    manifest,
    db,
    snapshot,
    seed,
    owner: documentOwner,
    rows: new Map(),
    coverage: new Map(),
    failures: volatileFailures,
    running: false,
    lastPublicationCheck: Date.now(),
    refreshing: false,
  };
}
const context = () => (contextPromise ??= boot());

async function refreshPublication(state) {
  if (
    state.refreshing ||
    state.running ||
    battleBusy ||
    document.querySelector('dialog[open]') ||
    Date.now() - state.lastPublicationCheck < 300000
  )
    return;
  state.refreshing = true;
  state.lastPublicationCheck = Date.now();
  try {
    const response = await request(manifestURL, { cache: 'no-store' });
    if (!response.ok) return;
    const manifest = await response.json();
    if (manifest.records === state.manifest.records) return;
    if (
      manifest.application_sha256 !== state.manifest.application_sha256 ||
      manifest.engine.bundle_sha256 !== state.manifest.engine.bundle_sha256
    ) {
      state.updateAvailable = true;
      return;
    }
    const [snapshot, seed] = await Promise.all([
      jsonAsset(new URL(manifest.catalog, manifestURL)),
      jsonAsset(new URL(manifest.records, manifestURL)),
    ]);
    if (state.running || battleBusy || document.querySelector('dialog[open]')) return;
    const viewedId = location.hash.match(/^#\/decks\/([^/]+)/)?.[1];
    const viewedDeck = state.seed.decks.find((deck) => deck.id === viewedId);
    if (viewedDeck) await freezeDeck(state, viewedDeck, state.snapshot);
    state.manifest = manifest;
    state.snapshot = snapshot;
    state.seed = seed;
    state.rows.clear();
    state.updateAvailable = false;
  } finally {
    state.refreshing = false;
  }
}
async function snapshotFor(state, id) {
  if (state.snapshot.id === id) return state.snapshot;
  const saved = await artifact(state.db, `snapshot:${id}`);
  if (!saved)
    throw new Error(
      'The frozen source snapshot is missing; a newer catalog will not be substituted.',
    );
  return saved;
}
function rowsFor(state, snapshot, asOf) {
  const within = policyWindow(state.seed.policy, asOf);
  const key = `${snapshot.id}:${asOf}:${within}`;
  if (!state.rows.has(key)) {
    if (state.rows.size >= 3) state.rows.delete(state.rows.keys().next().value);
    state.rows.set(
      key,
      within && snapshot.id === state.snapshot.id && asOf === state.seed.as_of
        ? state.seed.card_rows
        : assess(snapshot, state.seed.policy, asOf),
    );
  }
  return state.rows.get(key);
}
async function allDecks(state) {
  const merged = new Map(state.seed.decks.map((deck) => [deck.id, deck]));
  for (const deck of await list(state.db, 'deck')) merged.set(deck.id, deck);
  return [...merged.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
}
async function deckFor(state, id) {
  const deck = (await allDecks(state)).find((deck) => deck.id === id);
  if (!deck) throw new Error('Deck not found.');
  return deck;
}
async function workerCall(state, mode, payload) {
  const script = await bytes(new URL(state.manifest.browser_worker, manifestURL));
  if ((await fingerprint(script)) !== state.manifest.engine.browser_sha256)
    throw new Error('Browser rules engine checksum mismatch.');
  const url = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
  const worker = new Worker(url);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => finish('Browser worker exceeded 180 seconds; no winner is inferred.'),
      180000,
    );
    const finish = (error, value) => {
      clearTimeout(timeout);
      worker.terminate();
      URL.revokeObjectURL(url);
      if (error) reject(new Error(error));
      else resolve(value);
    };
    worker.onmessage = ({ data }) => finish(data.error, data.result);
    worker.onerror = (error) => finish(error.message);
    worker.onmessageerror = () => finish('Browser worker returned an unreadable result.');
    try {
      worker.postMessage({ id: 1, mode, payload });
    } catch (error) {
      finish(error.message);
    }
  });
}
async function coverageFor(state, deck, snapshot) {
  if (deck.battle_coverage?.engine.bundle_sha256 === state.manifest.engine.bundle_sha256)
    return deck.battle_coverage;
  const key = `${deck.id}:${state.manifest.engine.bundle_sha256}`;
  if (!state.coverage.has(key))
    state.coverage.set(
      key,
      workerCall(state, 'coverage', {
        deck,
        snapshot,
        engine: { ...state.manifest.engine, available: true },
      }).catch((error) => {
        state.coverage.delete(key);
        const message = `Executable coverage unavailable: ${error.message}`;
        return {
          ready: false,
          engine: { ...state.manifest.engine, available: false, message },
          cards: [],
          message,
        };
      }),
    );
  return state.coverage.get(key);
}
async function freezeDeck(state, deck, snapshot) {
  await artifact(state.db, `snapshot:${snapshot.id}`, snapshot);
  await put(state.db, 'deck', deck);
}
function validDate(value) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  )
    throw new Error('Invalid legality date.');
  return value;
}

export async function staticAPI(path, body) {
  const state = await context();
  const url = new URL(path, 'https://fieldnotes.invalid');
  const asOf = validDate(body?.as_of ?? url.searchParams.get('as_of') ?? today());
  const route = url.pathname.split('/').filter(Boolean);
  const engine = { ...state.manifest.engine, available: true };
  if (route[0] === 'health')
    return {
      status: 'ok',
      today: today(),
      default_as_of: today(),
      policy: state.seed.policy,
      source_status: sourceStatus(state.seed.policy),
    };
  if (route[0] === 'overview') {
    void refreshPublication(state).catch(() => {});
    const counts = {};
    for (const card of rowsFor(state, state.snapshot, asOf))
      counts[card.legality.status] = (counts[card.legality.status] ?? 0) + 1;
    const { cards: _cards, sets: _sets, ...snapshot } = state.snapshot;
    return {
      today: today(),
      as_of: asOf,
      policy: state.seed.policy,
      source_status: sourceStatus(state.seed.policy),
      snapshot,
      counts,
      decks: await allDecks(state),
      events: state.seed.events,
      experiments: await list(state.db, 'experiment'),
      jobs: await list(state.db, 'job'),
      battles: (await list(state.db, 'battle')).map(
        (battle) => state.failures.get(battle.id) ?? battle,
      ),
      engine,
      deployment: {
        mode: 'pages',
        built_at: state.manifest.built_at,
        local_storage: true,
        update_available: Boolean(state.updateAvailable),
      },
    };
  }
  if (route[0] === 'cards' && !route[1]) {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const status = url.searchParams.get('status') ?? 'legal';
    const category = url.searchParams.get('category') ?? '';
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    const filtered = rowsFor(state, state.snapshot, asOf).filter(
      (card) =>
        (status === 'all' || card.legality.status === status) &&
        (!category || card.category === category) &&
        `${card.name} ${card.set_code} ${card.number} ${card.id}`.toLowerCase().includes(q),
    );
    return {
      items: filtered.slice((page - 1) * 40, page * 40),
      total: filtered.length,
      page,
      page_size: 40,
      snapshot_id: state.snapshot.id,
    };
  }
  if (route[0] === 'cards' && route[1]) {
    const id = decodeURIComponent(route[1]);
    const card = state.snapshot.cards.find((card) => card.id === id);
    if (!card) throw new Error('Card not found.');
    return {
      card,
      ...rowsFor(state, state.snapshot, asOf).find((row) => row.id === id),
      provenance: {
        snapshot_id: state.snapshot.id,
        content_sha256: state.snapshot.content_sha256,
        source_commit: state.snapshot.source_commit,
        policy_sha256: state.seed.policy_sha256,
      },
    };
  }
  if (route[0] === 'sync') {
    if (battleBusy)
      throw new Error('Wait for the running battle to finish before refreshing published sources.');
    contextPromise = boot();
    await contextPromise;
    return put(state.db, 'job', {
      kind: 'published-refresh',
      status: 'completed',
      message:
        'Reloaded the published snapshot. GitHub Actions refreshes upstream sources automatically.',
    });
  }
  if (route[0] === 'events' && route[2] === 'import') {
    const decks = state.seed.decks.filter((deck) => deck.source.event_id === route[1]);
    if (!decks.length)
      throw new Error(
        'This event is not in the published top-finisher sample. Paste its exact decklist, or wait for a scheduled source update.',
      );
    return put(state.db, 'job', {
      kind: 'published-event',
      status: 'completed',
      message: `${decks.length} published deck versions are already in the notebook.`,
    });
  }
  if (route[0] === 'decks' && !route[1] && body) {
    if (!body.name?.trim() || body.name.length > 120 || !body.text || body.text.length > 20000)
      throw new Error('Provide a deck name and at most 20,000 characters of deck text.');
    const resolved = resolveDeck(body.text, state.snapshot);
    const validation = validateDeck(
      resolved,
      state.snapshot,
      rowsFor(state, state.snapshot, asOf),
      asOf,
    );
    await artifact(state.db, `snapshot:${state.snapshot.id}`, state.snapshot);
    const deck = await put(state.db, 'deck', {
      name: body.name.trim(),
      text: body.text,
      ...resolved,
      validation,
      snapshot_id: state.snapshot.id,
      policy: state.seed.policy,
      source: { type: 'manual' },
      sha256: await fingerprint(
        JSON.stringify(resolved.lines.map((line) => [line.card_id, line.count]).sort()),
      ),
    });
    return deck;
  }
  if (route[0] === 'decks' && route[1]) {
    const deck = await deckFor(state, route[1]);
    const snapshot = await snapshotFor(state, deck.snapshot_id);
    const details = {
      ...deck,
      current_validation: validateDeck(deck, snapshot, rowsFor(state, snapshot, asOf), asOf),
      card_details: deck.lines.map((line) => ({
        ...line,
        card: snapshot.cards.find((card) => card.id === line.card_id),
      })),
      battle_coverage: await coverageFor(state, deck, snapshot),
    };
    return details;
  }
  if (route[0] === 'experiments' && !route[1] && body) {
    const deck = await deckFor(state, body.deck_id);
    const snapshot = await snapshotFor(state, deck.snapshot_id);
    const validation = validateDeck(deck, snapshot, rowsFor(state, snapshot, asOf), asOf);
    if (validation.status !== 'ready') throw new Error('Deck is not ready under the dated policy.');
    if (!body.name?.trim() || body.name.length > 120)
      throw new Error('Provide an experiment name of at most 120 characters.');
    const full = {
      ...setupExperiment(
        deck,
        snapshot,
        body.target_ids,
        body.trials,
        body.seed,
        body.minimum ?? 1,
      ),
      id: crypto.randomUUID(),
      name: body.name.trim(),
      deck,
      as_of: asOf,
      validation,
      policy: state.seed.policy,
      algorithm_sha256: state.manifest.application_sha256,
      provenance: {
        snapshot_id: snapshot.id,
        content_sha256: snapshot.content_sha256,
        source_commit: snapshot.source_commit,
        policy_sha256: state.seed.policy_sha256,
      },
    };
    await freezeDeck(state, deck, snapshot);
    await artifact(state.db, `experiment:${full.id}`, full);
    const { samples: _samples, ...metadata } = full;
    return put(state.db, 'experiment', metadata);
  }
  if (route[0] === 'experiments' && route[1]) {
    const experiment = (await list(state.db, 'experiment')).find(
      (record) => record.id === route[1],
    );
    if (!experiment) throw new Error('Experiment not found.');
    return experiment;
  }
  if (route[0] === 'battles' && !route[1] && body) {
    if (battleBusy) throw new Error('A battle is already preparing or running in this tab.');
    battleBusy = true;
    try {
      if (
        !body.name?.trim() ||
        body.name.length > 120 ||
        body.deck_ids?.length !== 2 ||
        !Number.isInteger(body.seed) ||
        body.seed < 0 ||
        body.seed > 2147483647 ||
        !Number.isInteger(body.max_actions) ||
        body.max_actions < 2 ||
        body.max_actions > 5000 ||
        !Number.isInteger(body.max_turns) ||
        body.max_turns < 1 ||
        body.max_turns > 500
      )
        throw new Error('Invalid battle protocol.');
      const decks = [],
        snapshots = [],
        coverage = [];
      for (const id of body.deck_ids) {
        const deck = await deckFor(state, id);
        const snapshot = await snapshotFor(state, deck.snapshot_id);
        if (validateDeck(deck, snapshot, rowsFor(state, snapshot, asOf), asOf).status !== 'ready')
          throw new Error(`${deck.name} needs dated legality review.`);
        const report = await coverageFor(state, deck, snapshot);
        if (!report.ready)
          throw new Error(
            `${deck.name} has unmapped or mismatched effects; inspect its executable coverage.`,
          );
        decks.push(deck);
        snapshots.push(snapshot);
        coverage.push(report);
      }
      const payload = {
        mode: 'battle',
        seed: body.seed,
        max_actions: body.max_actions,
        max_turns: body.max_turns,
        decks: decks.map((deck, index) => ({
          name: `Seat ${index + 1} - ${deck.name}`,
          cards: coverage[index].cards.flatMap((card) =>
            Array(card.count).fill(card.engine_full_name),
          ),
        })),
      };
      if (!(await artifact(state.db, `bundle:${engine.bundle_sha256}`))) {
        const bundle = await bytes(new URL(state.manifest.node_worker, manifestURL));
        if ((await fingerprint(bundle)) !== engine.bundle_sha256)
          throw new Error('Offline engine bundle checksum mismatch.');
        await artifact(state.db, `bundle:${engine.bundle_sha256}`, bundle);
      }
      if (!(await artifact(state.db, `license:${engine.bundle_sha256}`))) {
        const license = await bytes(new URL('../static/THIRD_PARTY_LICENSE.txt', manifestURL));
        await artifact(
          state.db,
          `license:${engine.bundle_sha256}`,
          new TextDecoder().decode(license),
        );
      }
      for (let i = 0; i < decks.length; i++) await freezeDeck(state, decks[i], snapshots[i]);
      const battle = await put(state.db, 'battle', {
        name: body.name.trim(),
        status: 'running',
        policy: state.seed.policy,
        as_of: asOf,
        deck_ids: body.deck_ids,
        seed: body.seed,
        max_actions: body.max_actions,
        max_turns: body.max_turns,
        engine,
        coverage,
        owner: state.owner,
        snapshot_ids: snapshots.map((snapshot) => snapshot.id),
        deck_names: decks.map((deck) => deck.name),
        updated_at: now(),
      });
      state.running = true;
      const heartbeat = setInterval(
        () => put(state.db, 'battle', { ...battle, updated_at: now() }).catch(() => {}),
        10000,
      );
      workerCall(state, 'battle', payload)
        .then(async (result) => {
          clearInterval(heartbeat);
          const { frames: _frames, ...summary } = result;
          const completed = { ...battle, ...summary, updated_at: now() };
          await artifact(state.db, `battle:${battle.id}`, {
            battle: completed,
            input: payload,
            decks,
            result,
          });
          await put(state.db, 'battle', completed);
        })
        .catch(async (error) => {
          clearInterval(heartbeat);
          const failed = {
            ...battle,
            status: 'failed',
            reason: `${error.message} Battle was not finalized; no winner is inferred.`,
            updated_at: now(),
          };
          state.failures.set(battle.id, failed);
          await put(state.db, 'battle', failed).catch(() => {});
        })
        .finally(() => {
          clearInterval(heartbeat);
          state.running = false;
          battleBusy = false;
        });
      return battle;
    } catch (error) {
      battleBusy = false;
      throw error;
    }
  }
  if (route[0] === 'battles' && route[1]) {
    const battle =
      state.failures.get(route[1]) ??
      (await list(state.db, 'battle')).find((record) => record.id === route[1]);
    if (!battle) throw new Error('Battle not found.');
    if (route[2] === 'replay') {
      const full = await artifact(state.db, `battle:${battle.id}`);
      if (!full) throw new Error('Replay is not available until the worker has saved its result.');
      return full.result;
    }
    return battle;
  }
  throw new Error(`Unsupported browser operation: ${url.pathname}`);
}

export async function staticDownload(path) {
  const state = await context();
  const route = path.replace(/^\/api\//, '').split('/');
  let data, filename, type;
  if (route[0] === 'snapshot') {
    data = JSON.stringify(state.snapshot);
    filename = `cards-${state.snapshot.id}.json`;
    type = 'application/json';
  } else {
    const kind = route[0] === 'battles' ? 'battle' : 'experiment';
    const full = await artifact(state.db, `${kind}:${route[1]}`);
    if (!full) throw new Error('Complete research artifact not found.');
    const files = {};
    const add = (name, value) => {
      files[name] = strToU8(typeof value === 'string' ? value : JSON.stringify(value));
    };
    if (kind === 'experiment') {
      add('experiment.json', full);
      add('card-snapshot.json', await snapshotFor(state, full.provenance.snapshot_id));
      add('deck.txt', full.deck.text);
      add('policy.json', full.policy);
    } else {
      add('battle.json', full);
      add('input.json', full.input);
      for (let i = 0; i < full.decks.length; i++) {
        add(`deck-${i + 1}.txt`, full.decks[i].text);
        add(`card-snapshot-${i + 1}.json`, await snapshotFor(state, full.decks[i].snapshot_id));
      }
      add('engine-manifest.json', full.battle.engine);
      add(
        'policy.json',
        typeof full.battle.policy === 'object' && full.battle.policy !== null
          ? full.battle.policy
          : full.decks[0].policy,
      );
      files['engine.cjs'] = await artifact(state.db, `bundle:${full.battle.engine.bundle_sha256}`);
      if (!files['engine.cjs'])
        throw new Error('The frozen executable is missing; refusing a metadata-only download.');
      add(
        'THIRD_PARTY_LICENSE.txt',
        await artifact(state.db, `license:${full.battle.engine.bundle_sha256}`),
      );
    }
    add(
      'README.txt',
      kind === 'battle'
        ? 'Complete omniscient battle trace, frozen decks and catalogs, engine executable and input.\nRerun offline: node engine.cjs < input.json\nExperimental community engine; incomplete matches have no inferred winner.\n'
        : 'Every accepted trial, full source catalog, frozen deck and policy.\nSetup-only browser algorithm; not gameplay or a matchup win-rate estimate.\n',
    );
    data = zipSync(files, { level: 6 });
    filename = `${kind}-${route[1]}.zip`;
    type = 'application/zip';
  }
  const url = URL.createObjectURL(new Blob([data], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
