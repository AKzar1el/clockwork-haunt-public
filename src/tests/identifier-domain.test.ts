import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScenarioConfig } from '../engine/types.ts';
import { simulate } from '../engine/simulator.ts';
import { ch02 } from '../fixtures/ch02.ts';

test('a replay rejects non-string and empty identifier fields before key generation', () => {
  const edits: Array<[RegExp, (config: ScenarioConfig, invalid: string) => void]> = [
    [/scenarioId/, (c, v) => { c.scenarioId=v; }],
    [/Preloaded key/, (c, v) => { c.preloadedArtifacts![0].key=v; }],
    [/Preloaded attemptId/, (c, v) => { c.preloadedArtifacts![0].attemptId=v; }],
    [/Job id/, (c, v) => { c.jobs[0].id=v; }],
    [/Output key/, (c, v) => { c.jobs[0].output!.key=v; }],
    [/Input key/, (c, v) => { c.jobs[1].inputs[0].key=v; }],
    [/Wait policy key/, (c, v) => { c.jobs[1].waitPolicy={key:v,requiredWindow:1,deadline:495}; }],
  ];
  for (const [pattern, edit] of edits) {
    for (const invalid of [null, 9, ' ', ''] as unknown as string[]) {
      const copy = structuredClone(ch02);
      edit(copy,invalid);
      assert.throws(()=>simulate(copy),pattern);
    }
  }
});

test('valid punctuation remains literal in job identity and evidence', () => {
  const config = structuredClone(ch02);
  config.jobs[1].id='report:manual #1';
  const result = simulate(config);
  assert.equal(result.runs[1].jobId,'report:manual #1');
  assert.equal(result.eventLog.find(e=>e.kind==='Admission' && e.entityId===config.jobs[1].id)?.sortKey,'0486:2:report:manual #1');
});

test('publish hints allow embedded colons and negative windows, but reject misspelled keys', () => {
  const config = structuredClone(ch02);
  const report = config.jobs[1];
  report.inputs = [{key:'data:segment',requiredWindow:-2}];
  report.scheduledPublishMinutes = {'data:segment:-2':492};
  assert.equal(simulate(config).runs[1].reads[0].unavailableReason,'PublicationPending');
  for(const invalid of ['data-2','data:segment:-02','data:', ' :-2','data:9007199254740992']) {
    report.scheduledPublishMinutes = {[invalid]:492};
    assert.throws(()=>simulate(config),/Scheduled publish hint key/);
  }
});
