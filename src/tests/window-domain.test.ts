import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScenarioConfig } from '../engine/types.ts';
import { simulate } from '../engine/simulator.ts';

const baseline = (): ScenarioConfig => ({
  scenarioId:'window-domain', maxArtifactAge:10,
  jobs:[{id:'job', scheduledStart:10, runDuration:1, inputs:[], output:{key:'k', windowIndex:0}}],
});
test('all four window declarations reject ambiguous numeric keys before replay', () => {
  for (const bad of [NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const preload = baseline();
    preload.preloadedArtifacts = [{key:'k', windowIndex:bad, attemptId:'a', producerValid:true, publishMinute:5}];
    assert.throws(()=>simulate(preload), /Preloaded windowIndex/);
    const input = baseline();
    input.jobs[0].inputs = [{key:'k', requiredWindow:bad}];
    assert.throws(()=>simulate(input), /Input requiredWindow/);
    const wait = baseline();
    wait.jobs[0].waitPolicy = {key:'k', requiredWindow:bad, deadline:20};
    assert.throws(()=>simulate(wait), /Wait policy requiredWindow/);
    const output = baseline();
    output.jobs[0].output!.windowIndex = bad;
    assert.throws(()=>simulate(output), /Output windowIndex/);
  }
});

test('negative prior windows remain valid for relative timelines', () => {
  const config = baseline();
  config.preloadedArtifacts = [{key:'input', windowIndex:-1, attemptId:'a', producerValid:true, publishMinute:5}];
  config.jobs[0].inputs = [{key:'input', requiredWindow:0}];
  config.jobs[0].fallbackEnabled = true;
  assert.equal(simulate(config).runs[0].reads[0].actualWindowIndex,-1);
});
