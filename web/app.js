const state = {
  overview: null,
  asOf: '',
  query: '',
  status: 'legal',
  category: '',
  page: 1,
  request: 0,
};
const $ = (selector) => document.querySelector(selector);
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
const short = (value) => escape(value?.slice(0, 12) ?? '—');
const pct = (value) => `${(value * 100).toFixed(1)}%`;
const number = (value) => Number(value ?? 0).toLocaleString();
const route = () => (location.hash.slice(1) || '/cards').split('/');
const badge = (value) => `<span class="badge ${escape(value)}"><i></i>${escape(value)}</span>`;
const safeURL = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? escape(parsed.href) : '#';
  } catch {
    return '#';
  }
};
const link = (url, label) =>
  `<a class="source-link" href="${safeURL(url)}" target="_blank" rel="noreferrer">${escape(label)} ↗</a>`;
const empty = (title, text, action = '') =>
  `<section class="empty"><span class="empty-symbol">◇</span><h2>${escape(title)}</h2><p>${escape(text)}</p>${action}</section>`;
const button = (label, action, style = 'primary', extra = '') =>
  `<button class="button ${style}" data-action="${action}" ${extra}>${label}</button>`;

async function api(path, body) {
  const response = await fetch(
    `/api${path}`,
    body === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(
      typeof result?.detail === 'string'
        ? result.detail
        : JSON.stringify(result?.detail ?? `Request failed (${response.status})`),
    );
  }
  return response.json();
}

function alert(message) {
  $('#alerts').innerHTML = message
    ? `<div class="error" role="alert"><span>${escape(message)}</span><button aria-label="Dismiss error" data-action="dismiss">×</button></div>`
    : '';
}

function header(eyebrow, title, description, actions = '') {
  return `<div class="page-heading"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p>${description}</p></div><div class="heading-actions">${actions}</div></div>`;
}

function snapshotNote() {
  const snapshot = state.overview?.snapshot;
  return snapshot
    ? `<div class="snapshot-note"><span class="dot"></span>Latest bulk source <code>${short(snapshot.source_commit)}</code><span>·</span>Fetched ${escape(snapshot.fetched_at.slice(0, 10))}<span>·</span>Policy reviewed through ${escape(state.overview.policy.reviewed_through)}</div>`
    : '';
}

function syncPrompt() {
  return `<section class="panel">${empty('Bring the current card pool into focus.', 'Sync a versioned card snapshot and the recent in-person tournament index. No fabricated decks or results.', button('Sync research sources ↗', 'sync'))}</section>`;
}

function showJob() {
  const jobs = state.overview?.jobs ?? [];
  const job = jobs.find((item) => ['queued', 'running'].includes(item.status));
  $('#job-status').innerHTML = job
    ? `<div class="job"><span class="spinner"></span><strong>Source operation in progress</strong><span>${escape(job.message)}</span></div>`
    : '';
}

async function refresh(render = true) {
  const previous = state.overview;
  state.overview = await api(`/overview?as_of=${state.asOf}`);
  showJob();
  if (render) await renderRoute();
  else {
    const wasActive = previous?.jobs?.some((job) => ['running', 'queued'].includes(job.status));
    const active = state.overview.jobs.some((job) => ['running', 'queued'].includes(job.status));
    if (wasActive && !active) {
      const recent = state.overview.jobs[0];
      if (recent.status === 'failed' || recent.result?.failures?.length) alert(recent.message);
      await renderRoute();
    }
  }
}

async function renderRoute() {
  const [, section, id] = route();
  document
    .querySelectorAll('[data-nav]')
    .forEach((item) => item.classList.toggle('selected', item.dataset.nav === section));
  $('#breadcrumb').textContent =
    {
      cards: 'Card explorer',
      decks: 'Tournament decks',
      experiments: 'Experiments',
      sources: 'Sources & policy',
    }[section] ?? 'Workspace';
  if (section === 'cards' && id) return renderCard(id);
  if (section === 'decks' && id) return renderDeck(id);
  if (section === 'experiments' && id) return renderExperiment(id);
  if (section === 'decks') return renderDecks();
  if (section === 'experiments') return renderExperiments();
  if (section === 'sources') return renderSources();
  await renderCards();
}

async function renderCards() {
  const overview = state.overview;
  const counts = overview.counts;
  $('#content').innerHTML =
    header(
      'THE REAL-WORLD CARD POOL',
      'Card explorer',
      'Study what is playable. Know why it is legal.',
      button('↻ Sync sources', 'sync', 'secondary'),
    ) +
    `<div class="intro"><div><span class="eyebrow">STANDARD, WITH CONTEXT</span><h2>A card can be new.<br /><em>That doesn’t make it tournament legal.</em></h2><p>Explore dated legality decisions, exact printings, and the evidence behind them.<br />Then test real decks without confusing card data with a rules engine.</p></div><div class="intro-stamp"><span>H</span><span>I</span><span>J</span><small>REVIEWED · DATE-AWARE · LOCAL</small></div></div>` +
    `<div class="metrics"><article><span>Assessed legal printings</span><strong>${number(counts.legal)}</strong><small>Under the selected date & policy</small></article><article><span>Waiting for tournament play</span><strong>${number(counts.waiting)}</strong><small>Released, but not yet eligible</small></article><article><span>Need additional evidence</span><strong>${number(counts.review)}</strong><small>Reprints, promos & unresolved rules</small></article><article><span>Tournament deck versions</span><strong>${number(overview.decks.filter((deck) => deck.source.type === 'in-person-tournament').length)}</strong><small>Published lists, not metagame share</small></article></div>` +
    (!overview.snapshot
      ? syncPrompt()
      : `<section class="panel"><div class="panel-heading"><div><h3>Printing library</h3><p>Newest expansions first. Exact set and collector number.</p></div><a class="button secondary small" href="/api/snapshot/download">↓ Complete snapshot</a></div><div class="filters"><label class="search"><span>⌕</span><input id="card-search" type="search" placeholder="Search a card, set code, or collector number…" value="${escape(state.query)}" aria-label="Search cards" /></label><label><span class="sr-only">Legality status</span><select id="card-status"><option value="legal">Assessed legal</option><option value="waiting">Waiting period</option><option value="review">Needs review</option><option value="illegal">Illegal</option><option value="unreleased">Unreleased</option><option value="all">All printings</option></select></label><label><span class="sr-only">Card category</span><select id="card-category"><option value="">All categories</option><option value="Pokémon">Pokémon</option><option value="Trainer">Trainer</option><option value="Energy">Energy</option></select></label></div><div id="card-results">${empty('Loading the printing library…', '')}</div></section>`) +
    snapshotNote();
  if (!overview.snapshot) return;
  $('#card-status').value = state.status;
  $('#card-category').value = state.category;
  let debounce;
  $('#card-search').addEventListener('input', (event) => {
    state.query = event.target.value;
    state.page = 1;
    clearTimeout(debounce);
    debounce = setTimeout(() => loadCards().catch((error) => alert(error.message)), 250);
  });
  for (const [selector, key] of [
    ['#card-status', 'status'],
    ['#card-category', 'category'],
  ]) {
    $(selector).addEventListener('change', (event) => {
      state[key] = event.target.value;
      state.page = 1;
      loadCards().catch((error) => alert(error.message));
    });
  }
  await loadCards();
}

async function loadCards() {
  const request = ++state.request;
  const params = new URLSearchParams({
    q: state.query,
    status: state.status,
    category: state.category,
    page: state.page,
    as_of: state.asOf,
  });
  const result = await api(`/cards?${params}`);
  if (request !== state.request || !$('#card-results')) return;
  $('#card-results').innerHTML = result.items.length
    ? `<div class="table-wrap"><table><thead><tr><th>Card / printing</th><th>Category</th><th>Mark</th><th>Assessment</th><th>Legal from</th><th></th></tr></thead><tbody>${result.items.map((card) => `<tr><td><a class="row-title" href="#/cards/${encodeURIComponent(card.id)}">${escape(card.name)}</a><small>${escape(card.set_name)} · ${escape(card.set_code)} ${escape(card.number)}</small></td><td>${escape(card.category)}</td><td><span class="mark">${escape(card.mark ?? '—')}</span></td><td>${badge(card.legality.status)}</td><td class="mono">${escape(card.legality.legal_from ?? '—')}</td><td><a class="row-open" href="#/cards/${encodeURIComponent(card.id)}" aria-label="Inspect ${escape(card.name)}">↗</a></td></tr>`).join('')}</tbody></table></div><div class="pagination"><span>${number(result.total)} matching printings</span><div>${button('← Previous', 'prev-cards', 'secondary small', state.page <= 1 ? 'disabled' : '')}<span>Page ${state.page} / ${Math.ceil(result.total / 40)}</span>${button('Next →', 'next-cards', 'secondary small', state.page * 40 >= result.total ? 'disabled' : '')}</div></div>`
    : empty('No printings match those filters.', 'Try a different card name or legality status.');
}

async function renderCard(id) {
  const detail = await api(`/cards/${encodeURIComponent(id)}?as_of=${state.asOf}`);
  const card = detail.card;
  const detailRows = [
    ['Printing', `${detail.set_code} ${detail.number}`],
    ['Category', card.supertype],
    ['Regulation mark', detail.mark ?? 'Not printed'],
    ['Set', detail.set_name],
    ['Legal from', detail.legality.legal_from ?? 'Not established'],
    ['As of', state.asOf],
    ['Verified reprint', detail.legality.reprint_id ?? 'Not required / not established'],
  ];
  $('#content').innerHTML =
    `<a class="back" href="#/cards">← Card explorer</a>` +
    header(
      'ONE PRINTING. EXPLICIT EVIDENCE.',
      escape(card.name),
      `${escape(detail.set_name)} · ${escape(detail.id)}`,
      badge(detail.legality.status),
    ) +
    `<div class="detail-grid"><section class="panel card-preview"><span class="eyebrow">${escape(card.supertype)}</span><div class="card-name">${escape(card.name)}</div>${card.hp ? `<span class="hp">${escape(card.hp)} <small>HP</small></span>` : ''}<div class="card-art-placeholder"><span>${escape(detail.mark ?? '◇')}</span><small>METADATA VIEW · NO OFFICIAL ART</small></div>${(card.abilities ?? []).map((ability) => `<div class="card-rule"><span>ABILITY</span><h3>${escape(ability.name)}</h3><p>${escape(ability.text)}</p></div>`).join('')}${(card.attacks ?? []).map((attack) => `<div class="card-rule"><h3>${escape(attack.name)} <span>${escape(attack.damage)}</span></h3><p>${escape(attack.text)}</p></div>`).join('')}${(card.rules ?? []).map((rule) => `<p class="rule-text">${escape(rule)}</p>`).join('')}<span class="card-id">${escape(detail.set_code)} · ${escape(detail.number)}</span></section><div><section class="panel padded"><h3>Legality evidence</h3><div class="evidence"><strong>${escape(detail.legality.reason)}</strong><p>This is a data-backed assessment, not an official judge certification.</p></div><dl class="properties">${detailRows.map(([name, value]) => `<div><dt>${name}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>${detail.legality.source ? link(detail.legality.source, 'Read the supporting rule') : ''}</section><section class="note"><strong>Legal ≠ implemented in a battle engine.</strong><p>This card can be used in opening-hand experiments when its deck passes validation. Its card effects are not simulated.</p></section><details class="panel padded raw"><summary>Full source card record</summary><pre>${escape(JSON.stringify(card, null, 2))}</pre></details></div></div>` +
    snapshotNote();
}

function renderDecks() {
  const overview = state.overview;
  $('#content').innerHTML =
    header(
      'WHAT PEOPLE ACTUALLY BRING TO THE TABLE',
      'Tournament decks',
      'Published in-person lists, with exact cards and dated checks.',
      button('+ Import a deck', 'new-deck'),
    ) +
    `<div class="notice"><span>↗</span><p><strong>A deliberate sample, not a metagame census.</strong> Imports select published top finishers from international Standard events. Missing lists and unresolved printings stay visible.</p></div>` +
    `<section class="panel"><div class="panel-heading"><div><h3>Deck notebook <span class="count">${overview.decks.length}</span></h3><p>Every import retains its original list and source snapshot.</p></div></div>${overview.decks.length ? `<div class="table-wrap"><table><thead><tr><th>Deck</th><th>Source</th><th>Validation at import</th><th>Resolved</th><th></th></tr></thead><tbody>${overview.decks.map((deck) => `<tr><td><a class="row-title" href="#/decks/${deck.id}">${escape(deck.name)}</a><small>${escape(deck.sha256.slice(0, 12))} · ${escape(deck.validation.as_of)}</small></td><td>${deck.source.type === 'in-person-tournament' ? 'In-person event' : 'Manual import'}<small>${escape(deck.source.event_date ?? deck.created_at.slice(0, 10))}</small></td><td>${badge(deck.validation.status)}</td><td class="mono">${deck.total} / 60</td><td><a class="row-open" href="#/decks/${deck.id}" aria-label="Open ${escape(deck.name)}">↗</a></td></tr>`).join('')}</tbody></table></div>` : empty('Start with a real list.', 'Import a top-finishing tournament deck below, or paste your own exact printings.')}</section>` +
    `<section class="panel events"><div class="panel-heading"><div><h3>Recent in-person Standard events</h3><p>International Standard only. Japanese and online formats are not mixed into this sample.</p></div>${button('↻ Refresh events', 'sync-events', 'secondary small')}</div>${
      overview.events.length
        ? `<div class="event-grid">${overview.events
            .slice(0, 12)
            .map(
              (event) =>
                `<article class="event"><span class="eyebrow">${escape(event.date)} · IN PERSON</span><h3>${escape(event.name)}</h3><div>${link(event.url, 'Published results')}${button('Import top 8 ↗', 'import-event', 'secondary small', `data-id="${event.id}"`)}</div></article>`,
            )
            .join('')}</div>`
        : empty('No event index yet.', 'Sync sources to retrieve recent completed tournaments.')
    }</section>` +
    snapshotNote();
}

async function renderDeck(id) {
  const deck = await api(`/decks/${id}?as_of=${state.asOf}`);
  const validation = deck.current_validation;
  $('#content').innerHTML =
    `<a class="back" href="#/decks">← Tournament decks</a>` +
    header(
      'AN EXACT LIST, NOT A NAME MATCH',
      escape(deck.name),
      `As of ${escape(state.asOf)} · snapshot ${escape(deck.snapshot_id.slice(0, 10))}`,
      button(
        'Run consistency experiment →',
        'new-experiment',
        'primary',
        `data-id="${deck.id}" ${validation.status !== 'ready' ? 'disabled' : ''}`,
      ),
    ) +
    `<div class="metrics three"><article><span>Current assessment</span><strong class="status-text">${escape(validation.status)}</strong><small>Under the selected date</small></article><article><span>Resolved cards</span><strong>${validation.total} <em>/ 60</em></strong><small>Exact set + collector number + name</small></article><article><span>Basic Pokémon</span><strong>${validation.basic_count}</strong><small>Opening-hand eligibility</small></article></div>` +
    [...validation.errors, ...validation.warnings]
      .map(
        (message) =>
          `<div class="${validation.errors.includes(message) ? 'error' : 'notice'}">${escape(message)}</div>`,
      )
      .join('') +
    `<div class="deck-layout"><section class="panel"><div class="panel-heading"><h3>Resolved printings</h3>${badge(validation.status)}</div><div class="table-wrap"><table><thead><tr><th>Count</th><th>Card</th><th>Printing</th><th>Assessment</th></tr></thead><tbody>${deck.card_details.map((line) => `<tr><td class="mono">${line.count}</td><td><a class="row-title" href="#/cards/${encodeURIComponent(line.card.id)}">${escape(line.card.name)}</a></td><td class="mono">${escape(line.card.set_id)} ${escape(line.card.number)}</td><td>${badge(validation.cards.find((card) => card.card_id === line.card.id)?.status ?? 'review')}</td></tr>`).join('')}</tbody></table></div></section><div><section class="panel padded"><h3>Original import</h3><pre class="deck-text">${escape(deck.text)}</pre></section><section class="panel padded provenance"><h3>Provenance</h3><p>${escape(deck.source.coverage ?? 'Manually supplied exact-printing decklist.')}</p>${deck.source.url ? link(deck.source.url, 'Original tournament list') : ''}<dl class="properties"><div><dt>Event date</dt><dd>${escape(deck.source.event_date ?? 'Manual')}</dd></div><div><dt>Card snapshot</dt><dd><code>${escape(deck.snapshot_id.slice(0, 12))}</code></dd></div><div><dt>Deck fingerprint</dt><dd><code>${escape(deck.sha256.slice(0, 12))}</code></dd></div></dl></section></div></div>` +
    snapshotNote();
}

function renderExperiments() {
  const experiments = state.overview.experiments;
  $('#content').innerHTML =
    header(
      'MAKE THE SMALL DECISIONS MEASURABLE',
      'Experiments',
      'Reproducible opening hands, mulligans, prizes, and first draws.',
      button('+ New experiment', 'new-experiment'),
    ) +
    `<div class="intro compact-intro"><div><span class="eyebrow">SOURCED CARD POOL. EXPLICIT MODEL.</span><h2>Will the card be there<br /><em>when your opening depends on it?</em></h2><p>Test real decklists across thousands of seeded setups. Every trial is saved.<br />No card effects, opponent bonus draws, gameplay, or battle win rates are inferred.</p></div></div>` +
    `<section class="panel"><div class="panel-heading"><div><h3>Experiment ledger <span class="count">${experiments.length}</span></h3><p>Conditional on a valid opening hand with a Basic Pokémon.</p></div></div>${experiments.length ? `<div class="table-wrap"><table><thead><tr><th>Experiment</th><th>Trials</th><th>Opening target</th><th>Any target prized</th><th>Seed</th><th></th></tr></thead><tbody>${experiments.map((experiment) => `<tr><td><a class="row-title" href="#/experiments/${experiment.id}">${escape(experiment.name)}</a><small>${escape(experiment.deck.name)}</small></td><td class="mono">${number(experiment.trials)}</td><td class="mono">${pct(experiment.metrics.opening_target.probability)}</td><td class="mono">${pct(experiment.metrics.target_prized.probability)}</td><td class="mono">${experiment.seed}</td><td><a class="row-open" href="#/experiments/${experiment.id}" aria-label="Open ${escape(experiment.name)}">↗</a></td></tr>`).join('')}</tbody></table></div>` : empty('One hypothesis. Thousands of openings.', 'Select a validated deck to start a consistency experiment.', button('Choose a tournament deck →', 'go-decks', 'secondary'))}</section>`;
}

async function renderExperiment(id) {
  const experiment = await api(`/experiments/${id}`);
  const metricNames = {
    opening_target: 'Target in opening seven',
    target_prized: 'Any target in prizes',
    target_by_first_draw: 'Target by first natural draw',
    any_mulligan: 'At least one mulligan',
  };
  $('#content').innerHTML =
    `<a class="back" href="#/experiments">← Experiments</a>` +
    header(
      'A REPRODUCIBLE RECORD',
      escape(experiment.name),
      `${number(experiment.trials)} accepted setups · seed ${experiment.seed} · ${escape(experiment.as_of)}`,
      `<a class="button primary" href="/api/experiments/${id}/download">↓ Complete experiment</a>`,
    ) +
    `<div class="metrics">${Object.entries(experiment.metrics)
      .map(
        ([key, metric]) =>
          `<article><span>${metricNames[key]}</span><strong>${pct(metric.probability)}</strong><small>95% Wilson: ${metric.ci95.map(pct).join(' – ')}</small></article>`,
      )
      .join('')}</div>` +
    `<div class="detail-grid"><section class="panel padded"><h3>Frozen protocol</h3><dl class="properties"><div><dt>Deck</dt><dd><a href="#/decks/${experiment.deck.id}">${escape(experiment.deck.name)}</a></dd></div><div><dt>Target printing(s)</dt><dd>${experiment.target_ids.map(escape).join(', ')}</dd></div><div><dt>Minimum target count</dt><dd>${experiment.minimum}</dd></div><div><dt>Mean mulligans</dt><dd class="mono">${experiment.mean_mulligans.toFixed(3)}</dd></div><div><dt>Exact initial mulligan rate</dt><dd class="mono">${pct(experiment.exact_initial_mulligan_probability)}</dd></div><div><dt>Unconditioned target probability</dt><dd class="mono">${pct(experiment.unconditional_opening_target_probability)}</dd></div><div><dt>Algorithm fingerprint</dt><dd><code>${short(experiment.algorithm_sha256)}</code></dd></div><div><dt>Source commit</dt><dd><code>${short(experiment.provenance.source_commit)}</code></dd></div><div><dt>Python version</dt><dd>${escape(experiment.python_version)}</dd></div></dl></section><section class="panel padded"><h3>What this experiment does—and does not—say</h3><ol class="assumptions">${experiment.assumptions.map((text) => `<li>${escape(text)}</li>`).join('')}</ol><div class="note"><strong>A complete research artifact.</strong><p>The download includes all trial hands, prizes, first draws, mulligan counts, the full card snapshot, original deck, and policy—not just summary metrics.</p></div></section></div>`;
}

function renderSources() {
  const overview = state.overview;
  const snapshot = overview.snapshot;
  $('#content').innerHTML =
    header(
      'KNOW WHERE YOUR ANSWERS COME FROM',
      'Sources & policy',
      'Inspect the dates, evidence, and data boundaries behind the workspace.',
      button('↻ Sync all sources', 'sync'),
    ) +
    `<div class="detail-grid"><section class="panel padded"><span class="eyebrow">CARD DATA</span><h2>Immutable source snapshots.</h2><p class="lead">English printing records are downloaded from a specific public repository commit. No dependency on the soon-to-retire Pokémon TCG API service.</p>${snapshot ? `<dl class="properties"><div><dt>Source commit</dt><dd><code>${short(snapshot.source_commit)}</code></dd></div><div><dt>Source updated</dt><dd>${escape(snapshot.source_updated_at)}</dd></div><div><dt>Retrieved</dt><dd>${escape(snapshot.fetched_at)}</dd></div><div><dt>English printings</dt><dd>${number(snapshot.card_count)}</dd></div><div><dt>Sets in snapshot</dt><dd>${number(snapshot.set_count)}</dd></div><div><dt>Latest release in data</dt><dd>${escape(snapshot.latest_release)}</dd></div><div><dt>Content fingerprint</dt><dd><code>${short(snapshot.content_sha256)}</code></dd></div></dl>${link(snapshot.source, 'Inspect upstream dataset')}<div class="note"><p>${escape(snapshot.provider_notice)}</p></div><a class="button secondary" href="/api/snapshot/download">↓ Full card snapshot</a>` : '<p class="lead">No snapshot yet. Sync sources to begin.</p>'}</section><section class="panel padded"><span class="eyebrow">DATED RULES</span><h2>Conservative by design.</h2><dl class="properties"><div><dt>Format / region</dt><dd>${escape(overview.policy.format)} / ${escape(overview.policy.region)}</dd></div><div><dt>Effective from</dt><dd>${escape(overview.policy.effective_from)}</dd></div><div><dt>Reviewed through</dt><dd>${escape(overview.policy.reviewed_through)}</dd></div><div><dt>Accepted marks</dt><dd>${overview.policy.legal_marks.join(' · ')}</dd></div><div><dt>Handbook sections</dt><dd>${overview.policy.handbook_sections.join(' / ')}</dd></div></dl>${link(overview.policy.handbook, 'Official tournament handbook')}<ul class="assumptions">${overview.policy.notes.map((note) => `<li>${escape(note)}</li>`).join('')}</ul><p class="small-muted">${escape(overview.policy.ban_evidence)}</p></section></div>` +
    `<section class="panel events"><div class="panel-heading"><div><h3>Source operations</h3><p>Failures do not replace previously completed card snapshots.</p></div></div>${overview.jobs.length ? `<div class="table-wrap"><table><thead><tr><th>Operation</th><th>Status</th><th>Details</th><th>Started</th></tr></thead><tbody>${overview.jobs.map((job) => `<tr><td>${escape(job.kind)}</td><td>${badge(job.status)}</td><td class="wrap-cell">${escape(job.message)}</td><td>${escape(job.created_at.slice(0, 16).replace('T', ' '))}</td></tr>`).join('')}</tbody></table></div>` : empty('No source operations yet.', 'Sync sources to create a traceable starting point.')}</section><div class="note"><strong>Separate from Counterplay.</strong><p>This project studies current tournament cards and deck consistency. It neither expands CABT’s rules implementation nor exports unsupported lists as executable battles. No Kaggle workflow.</p></div>`;
  if (snapshot?.supplements?.length) {
    $('#content .detail-grid section').insertAdjacentHTML(
      'beforeend',
      `<div class="note"><strong>Supplemental exact-printing evidence</strong>${snapshot.supplements.map((item) => `<p>${link(item.source, `${number(item.cards)} Basic Energy printings`)}<br />Retrieved ${escape(item.fetched_at)}<br />Index hash <code>${short(item.source_sha256)}</code></p>`).join('')}<p>These records are included in the combined snapshot hash, not the bulk repository commit.</p></div>`,
    );
  }
}

function modal(title, content) {
  $('#dialog').innerHTML =
    `<div class="modal-heading"><div><span class="eyebrow">RESEARCH NOTEBOOK</span><h2>${title}</h2></div><button class="close" data-action="close" aria-label="Close dialog">×</button></div>${content}`;
  $('#dialog').showModal();
}

function deckModal() {
  modal(
    'Import an exact decklist',
    `<form id="deck-form" class="modal-form"><label>Deck name<input name="name" required maxlength="120" placeholder="My current Standard list" /></label><label>Original list<textarea name="text" required rows="12" placeholder="4 Slowpoke SCR 57&#10;3 Slowking SCR 58&#10;…"></textarea></label><div class="note"><p>Use “quantity name SET number” on each line. All 60 cards must resolve exactly. Unrecognized or ambiguous printings remain errors.</p></div><div class="form-error" role="alert"></div><button class="button primary">Validate & save deck →</button></form>`,
  );
  $('#deck-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const data = Object.fromEntries(new FormData(form));
    form.querySelector('button').disabled = true;
    try {
      const deck = await api('/decks', { ...data, as_of: state.asOf });
      $('#dialog').close();
      await refresh(false);
      location.hash = `/decks/${deck.id}`;
    } catch (error) {
      form.querySelector('.form-error').textContent = error.message;
    } finally {
      form.querySelector('button').disabled = false;
    }
  });
}

async function experimentModal(deckId) {
  const decks = state.overview.decks;
  if (!decks.length) {
    modal(
      'Start with a deck',
      `<div class="modal-form">${empty('No decklists yet.', 'Import a tournament list or paste your own before running an experiment.', button('Choose a deck →', 'go-decks', 'secondary'))}</div>`,
    );
    return;
  }
  modal(
    'New consistency experiment',
    `<form id="experiment-form" class="modal-form"><label>Experiment name<input name="name" required maxlength="120" value="Opening consistency" /></label><label>Deck<select id="experiment-deck" name="deck_id">${decks.map((deck) => `<option value="${deck.id}">${escape(deck.name)}</option>`).join('')}</select></label><label>Target printing<select id="experiment-target" name="target" required></select></label><div class="form-grid"><label>Accepted setups<input type="number" name="trials" min="100" max="20000" required value="5000" /></label><label>Random seed<input type="number" name="seed" min="0" max="2147483647" required value="42" /></label></div><label>At least this many target copies<input name="minimum" type="number" min="1" max="7" required value="1" /></label><div class="note"><p>Conditional opening-hand sampling, not battle simulation. No card effects or opponent mulligan bonus draws. Every trial is retained.</p></div><div class="form-error" role="alert"></div><button class="button primary">Run reproducible experiment →</button></form>`,
  );
  if (deckId) $('#experiment-deck').value = deckId;
  const form = $('#experiment-form');
  const deckSelect = $('#experiment-deck');
  const select = $('#experiment-target');
  const submit = form.querySelector('button');
  let targetRequest = 0;
  const updateTargets = async () => {
    const request = ++targetRequest;
    submit.disabled = true;
    select.innerHTML = '<option value="">Loading…</option>';
    form.querySelector('.form-error').textContent = '';
    try {
      const deck = await api(`/decks/${deckSelect.value}?as_of=${state.asOf}`);
      if (request !== targetRequest || !form.isConnected) return;
      select.innerHTML = deck.card_details
        .map(
          (line) =>
            `<option value="${escape(line.card.id)}">${escape(line.card.name)} · ${escape(line.card.id)} · ${line.count} copies</option>`,
        )
        .join('');
      submit.disabled = deck.current_validation.status !== 'ready';
      if (submit.disabled) {
        form.querySelector('.form-error').textContent =
          'This deck needs resolution or legality review before running experiments.';
      }
    } catch (error) {
      if (request === targetRequest && form.isConnected) {
        form.querySelector('.form-error').textContent = error.message;
      }
    }
  };
  deckSelect.addEventListener('change', updateTargets);
  await updateTargets();
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const data = Object.fromEntries(new FormData(form));
    form.querySelector('button').disabled = true;
    try {
      const experiment = await api('/experiments', {
        name: data.name,
        deck_id: data.deck_id,
        target_ids: [data.target],
        minimum: Number(data.minimum),
        trials: Number(data.trials),
        seed: Number(data.seed),
        as_of: state.asOf,
      });
      $('#dialog').close();
      await refresh(false);
      location.hash = `/experiments/${experiment.id}`;
    } catch (error) {
      form.querySelector('.form-error').textContent = error.message;
    } finally {
      form.querySelector('button').disabled = false;
    }
  });
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  const action = target.dataset.action;
  try {
    if (action === 'dismiss') return alert('');
    if (action === 'close') return $('#dialog').close();
    if (action === 'go-decks') {
      $('#dialog').close();
      location.hash = '/decks';
      return;
    }
    if (action === 'new-deck') return deckModal();
    if (action === 'new-experiment') return await experimentModal(target.dataset.id);
    if (action === 'prev-cards' || action === 'next-cards') {
      state.page += action === 'next-cards' ? 1 : -1;
      return await loadCards();
    }
    if (action === 'sync' || action === 'sync-events') {
      await api('/sync', { kind: action === 'sync-events' ? 'events' : 'all' });
      await refresh(false);
    }
    if (action === 'import-event') {
      await api(`/events/${target.dataset.id}/import`, { top: 8 });
      await refresh(false);
    }
  } catch (error) {
    alert(error.message);
  }
});
$('#dialog').addEventListener('click', (event) => {
  if (event.target === $('#dialog')) $('#dialog').close();
});
$('#as-of').addEventListener('change', async (event) => {
  if (!event.target.value) return;
  state.asOf = event.target.value;
  state.page = 1;
  try {
    await refresh();
  } catch (error) {
    alert(error.message);
  }
});
window.addEventListener('hashchange', () => renderRoute().catch((error) => alert(error.message)));

async function start() {
  const health = await api('/health');
  state.asOf = health.today;
  $('#as-of').value = state.asOf;
  await refresh();
  setInterval(() => refresh(false).catch((error) => alert(error.message)), 2500);
}
start().catch((error) => alert(error.message));
