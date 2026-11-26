import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completionWithoutEffect, cutoffArtifactExplanation, freshnessDrivers, primaryRunFirst, readAgeSummary, scopedReplayUrl } from '../ui/presentation.ts';
import { simulate } from '../engine/simulator.ts';

test('cutoff explanation separates an observed old or invalid release from no publication', () => {
  const target = {key:'input',requiredWindow:1};
  const base = {scenarioId:'cutoff-age',maxArtifactAge:3,
    jobs:[{id:'report',scheduledStart:5,runDuration:1,inputs:[],waitPolicy:{...target,deadline:6}}]};
  for (const [supplied,text] of [
    [[],null],
    [[{...target,windowIndex:1,publishMinute:0,attemptId:'old',producerValid:true}],
      'Published at 00:00, but was 6 min old at cutoff (limit: 3 min).'],
    [[{...target,windowIndex:1,publishMinute:0,attemptId:'invalid',producerValid:false}],
      'Published at 00:00, but the producing attempt was invalid.'],
  ] as const) {
    const result = simulate({...base,preloadedArtifacts:[...supplied]});
    const miss = result.trace.find(entry=>entry.kind==='DeadlineMiss')!;
    assert.equal(cutoffArtifactExplanation(miss.detail,miss.eventMinute,base.maxArtifactAge),text);
    assert.equal(result.runs[0].reads.length,0);
  }
});

test('a share URL preserves the mounted app but removes address-bar credentials and metadata', () => {
  const url = scopedReplayUrl('https://example-user:example-password@example.test:8443/mount/?internal=notes#position');
  assert.equal(url.href,'https://example.test:8443/mount/');
  assert.equal(url.username,'');
  assert.equal(url.password,'');
  assert.equal(scopedReplayUrl('https://example.test/clockwork-haunt-public/?scenario=late').pathname,
    '/clockwork-haunt-public/');
});

test('multi-input summaries show the oldest measured age without inventing missing ages', () => {
  assert.deepEqual(readAgeSummary([{artifactAge:0},{artifactAge:null},{artifactAge:22}]),
    {title:'Oldest measured read age',age:22});
  assert.deepEqual(readAgeSummary([{artifactAge:null},{artifactAge:null}]),{title:'Oldest measured read age',age:null});
  assert.deepEqual(readAgeSummary([{artifactAge:0}]),{title:'Age at Read',age:0});
  assert.deepEqual(readAgeSummary([]),{title:'Age at Read',age:null});
});

test('a case selects its intended primary run without relying on job-name prefixes', () => {
  const runs = [{jobId:'report-ingest'},{jobId:'nightly-summary'},{jobId:'cleanup'}];
  assert.deepEqual(primaryRunFirst(runs,'nightly-summary').map(x=>x.jobId),['nightly-summary','report-ingest','cleanup']);
  assert.equal(primaryRunFirst(runs,'unconfigured'),runs);
  assert.equal(primaryRunFirst(runs,undefined),runs);
  assert.deepEqual(runs.map(x=>x.jobId),['report-ingest','nightly-summary','cleanup']);
});

test('completion text distinguishes a failed producer from a no-output job', () => {
  assert.equal(completionWithoutEffect('Failure',true),'Failed without publishing');
  assert.equal(completionWithoutEffect('Failure',false),'Failed; no output declared');
  assert.equal(completionWithoutEffect('Success',false),'No output declared');
  assert.equal(completionWithoutEffect('Success',true),null);
});

test('missing input drivers do not get confused with measured stale data', () => {
  const reads = [
    {state:'Stale',key:'older',requiredWindow:1},
    {state:'Missing',key:'a',requiredWindow:1},
    {state:'Missing',key:'b',requiredWindow:2},
    {state:'Missing',key:'c',requiredWindow:3},
    {state:'Missing',key:'d',requiredWindow:4},
  ] as const;
  assert.equal(freshnessDrivers(reads,'Missing'),'a W1, b W2, c W3 and 1 more');
  assert.equal(freshnessDrivers(reads.slice(0,1),'Stale'),null);
  assert.equal(freshnessDrivers([],null),null);
});
