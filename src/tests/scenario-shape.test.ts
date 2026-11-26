import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScenarioConfig } from '../engine/types.ts';
import { simulate } from '../engine/simulator.ts';
import { buildReplayEvidence } from '../export/evidence.ts';

const base = {scenarioId:'shape',maxArtifactAge:3,jobs:[{id:'j',scheduledStart:1,runDuration:1,inputs:[]}]};

test('malformed scenario containers fail with field-level replay diagnostics', () => {
  const invalid: Array<[unknown, RegExp]> = [
    [null,/Scenario must be an object/],
    [{...base,jobs:{}},/Scenario jobs must be an array/],
    [{...base,jobs:[null]},/Job must be an object/],
    [{...base,jobs:[{...base.jobs[0],inputs:null}]},/Inputs for j must be an array/],
    [{...base,jobs:[{...base.jobs[0],inputs:[null]}]},/Input must be an object/],
    [{...base,jobs:[{...base.jobs[0],output:[]}]},/Output must be an object/],
    [{...base,jobs:[{...base.jobs[0],waitPolicy:'bad'}]},/Wait policy must be an object/],
    [{...base,jobs:[{...base.jobs[0],scheduledPublishMinutes:[]}]},/Scheduled publish minutes must be an object/],
    [{...base,preloadedArtifacts:null},/Preloaded artifacts must be an array/],
    [{...base,preloadedArtifacts:[null]},/Preloaded artifact must be an object/],
  ];
  for (const [value, reason] of invalid) assert.throws(()=>simulate(value as ScenarioConfig),reason);
  assert.equal(simulate(base).runs[0].completionStatus,'Success');
});

test('publication hints cannot affect a replay unless they are recorded as input data', () => {
  const input = {key:'later',requiredWindow:1};
  const hints = Object.defineProperty({},'later:1',{value:2,enumerable:false});
  const scenario = {...base,jobs:[{...base.jobs[0],inputs:[input],scheduledPublishMinutes:hints}]};
  assert.equal(simulate(scenario).runs[0].reads[0].state,'Missing');
  assert.deepEqual(simulate(scenario).runs,buildReplayEvidence(scenario).runs);
  const explicit = {...scenario,jobs:[{...scenario.jobs[0],scheduledPublishMinutes:{'later:1':2}}]};
  assert.equal(simulate(explicit).runs[0].reads[0].unavailableReason,'PublicationPending');
  assert.deepEqual(simulate(explicit).runs,buildReplayEvidence(explicit).runs);
});
