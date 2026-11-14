import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assess, policyWindow, sourceStatus } from '../web/research.js';

const policy = {
  effective_from: '2026-04-10',
  reviewed_through: '2026-11-16',
  legal_marks: ['H', 'I', 'J'],
  set_overrides: {},
  verification: {
    checked_at: '2026-11-14T12:00:00+00:00',
    valid_until: '2026-11-15T18:00:00+00:00',
  },
};
const snapshot = {
  sets: [{ id: 'test', name: 'Test expansion', releaseDate: '2026/11/06' }],
  cards: [
    { id: 'test-1', name: 'Test', supertype: 'Pokémon', regulationMark: 'H', set_id: 'test' },
    {
      id: 'test-2',
      name: 'Basic Fire Energy',
      supertype: 'Energy',
      subtypes: ['Basic'],
      set_id: 'test',
    },
  ],
};

test('live policy respects expiration and rejects unverified future dates', () => {
  assert.equal(sourceStatus(policy, new Date('2026-11-14T14:00:00Z')).status, 'fresh');
  assert.equal(sourceStatus(policy, new Date('2026-11-15T19:00:00Z')).status, 'stale');
  assert.equal(policyWindow(policy, '2026-11-15', new Date('2026-11-14T14:00:00Z')), false);
  assert.equal(policyWindow(policy, '2026-11-15', new Date('2026-11-15T17:00:00Z')), true);
  assert.equal(policyWindow(policy, '2026-11-15', new Date('2026-11-15T19:00:00Z')), false);
});

test('expired current assessments cannot be rescued by Basic Energy or reprints', () => {
  const rows = assess(snapshot, policy, '2026-11-15', new Date('2026-11-15T19:00:00Z'));
  assert.ok(rows.every((row) => row.legality.status === 'review'));
  assert.equal(
    assess(snapshot, policy, '2026-11-14', new Date('2026-11-15T19:00:00Z')).find(
      (row) => row.id === 'test-1',
    ).legality.status,
    'waiting',
  );
});

test('automatic verified refreshes admit new expansions after their waiting period', () => {
  const refreshed = {
    ...policy,
    reviewed_through: '2026-11-21',
    verification: {
      checked_at: '2026-11-20T12:00:00Z',
      valid_until: '2026-11-21T18:00:00Z',
    },
  };
  assert.ok(
    assess(snapshot, refreshed, '2026-11-20', new Date('2026-11-20T13:00:00Z')).every(
      (row) => row.legality.status === 'legal',
    ),
  );
  const rotated = { ...refreshed, legal_marks: ['I', 'J', 'K'] };
  assert.equal(
    assess(snapshot, rotated, '2026-11-20', new Date('2026-11-20T13:00:00Z')).find(
      (row) => row.id === 'test-1',
    ).legality.status,
    'review',
  );
});
