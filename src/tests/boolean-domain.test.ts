import assert from 'node:assert/strict';
import { test } from 'node:test';
import { simulate } from '../engine/simulator.ts';
import { ch02 } from '../fixtures/ch02.ts';

test('replay rejects truthy string and null flags instead of coercing them', () => {
  for (const invalid of ['false','true',0,null] as unknown as boolean[]) {
    const preload = structuredClone(ch02);
    preload.preloadedArtifacts![0].producerValid = invalid;
    assert.throws(()=>simulate(preload),/Preloaded producerValid/);
    const fallback = structuredClone(ch02);
    fallback.jobs[1].fallbackEnabled = invalid;
    assert.throws(()=>simulate(fallback),/fallbackEnabled/);
    const dedupe=structuredClone(ch02);
    dedupe.jobs[0].deduplicationEnabled = invalid;
    assert.throws(()=>simulate(dedupe),/deduplicationEnabled/);
  }
});

test('explicit false fallback never consumes the prior window', () => {
  const cloned=structuredClone(ch02);
  cloned.jobs[1].fallbackEnabled = false;
  const report=simulate(cloned).runs[1];
  assert.equal(report.reads[0].state,'Unknown');
  assert.equal(report.reads[0].actualWindowIndex,null);
});
