import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateDeck, runPair } from './cold-start.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

test('generated RC ladders contain exactly the requested nodes', () => {
  for (const count of [10, 100, 1000]) {
    const deck = generateDeck(count);
    const nodes = new Set(deck.match(/\bn\d+\b/g));
    assert.equal(nodes.size, count);
  }
});

test('fresh processes use identical deck bytes and report bounded positive phases', () => {
  const deck = generateDeck(10);
  const result = runPair(deck);
  assert.equal(result.spice.deckSha256, hash(deck));
  assert.equal(result.ngspice.deckSha256, hash(deck));
  const phases = [result.spice.importMs, result.spice.parseMs, result.spice.setupMs, result.spice.solveMs];
  for (const phase of [...phases, result.spice.totalMs, result.ngspice.totalMs]) {
    assert.ok(Number.isFinite(phase) && phase > 0);
  }
  assert.ok(phases.reduce((sum, phase) => sum + phase, 0) <= result.spice.totalMs);
});
