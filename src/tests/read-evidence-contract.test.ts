import assert from 'node:assert/strict';
import { test } from 'node:test';
import { simulate } from '../engine/simulator.ts';
import { buildReplayEvidence } from '../export/evidence.ts';
import type { ScenarioConfig } from '../engine/types.ts';
import { ch02 } from '../fixtures/ch02.ts';
import { readStateDetail } from '../ui/presentation.ts';
import { verifyEvidence } from '../../scripts/verify-evidence.mjs';

test('invalid producer and pending publication both export no used window', () => {
  const input: ScenarioConfig = {
    scenarioId:'unknown-evidence', maxArtifactAge:10,
    jobs:[{id:'r',scheduledStart:10,runDuration:1,
      inputs:[{key:'invalid',requiredWindow:3},{key:'pending',requiredWindow:4},{key:'missing',requiredWindow:5}],
      scheduledPublishMinutes:{'pending:4':11}}],
    preloadedArtifacts:[{key:'invalid',windowIndex:3,attemptId:'bad',producerValid:false,publishMinute:9}],
  };
  const expected = [[3,'Unknown',null,null,null],[4,'Unknown',null,null,null],[5,'Missing',null,null,null]];
  const direct = simulate(input);
  for (const read of direct.runs[0].reads) {
    assert(Object.isFrozen(read));
    assert.equal(Object.keys(read)[0],'readId');
    assert.equal(read.readId,JSON.stringify(['r',read.key,read.requiredWindow,10]));
  }
  for (const data of [direct,buildReplayEvidence(input)]) {
    assert.equal(data.runs[0].inputFreshnessStatus, 'Missing');
    assert.deepEqual(data.runs[0].reads.map(r => [r.requiredWindow,r.state,r.actualWindowIndex,r.publishMinute,r.artifactAge]),expected);
    assert(data.runs[0].reads.every(r => r.producerAttemptId === null));
    assert.deepEqual(data.runs[0].reads.map(r=>r.unavailableReason), ['InvalidProducer','PublicationPending','NotAvailableAtRead']);
    assert.deepEqual(data.runs[0].reads.map(readStateDetail), ['Unknown: producer invalid','Unknown: publication not due yet','Missing at read time']);
  }
});

test('observed publication beats a future hint and the hint expires at its exact minute', () => {
  const target = {key:'k', requiredWindow:2};
  const jobs = [14,15,16].map(minute=>({
    id:'report-'+minute, scheduledStart:minute, runDuration:1,
    inputs:[target], scheduledPublishMinutes:{'k:2':15},
  }));
  const scenario: ScenarioConfig = {scenarioId:'hint-boundary',maxArtifactAge:10,jobs};
  const missing = simulate(scenario);
  assert.deepEqual(missing.runs.map(run=>run.reads[0].unavailableReason),[
    'PublicationPending','NotAvailableAtRead','NotAvailableAtRead',
  ]);
  const early = simulate({...scenario,jobs:[{
    id:'collector-early',scheduledStart:9,runDuration:1,inputs:[],output:{key:'k',windowIndex:2},
  }, ...jobs]});
  const ages = early.runs.slice(1).map(run=>{
    const read=run.reads[0];
    assert.equal(read.state,'Fresh');
    assert.equal(read.producerAttemptId,'collector-early');
    assert.equal(read.publishMinute,10);
    return read.artifactAge;
  });
  assert.deepEqual(ages,[4,5,6]);
});

test('a stale read records the chosen attempt separately from the planned producer', () => {
  const evidence = buildReplayEvidence(ch02);
  const read = evidence.runs.find(r=>r.jobId==='report-w1')!.reads[0];
  assert.equal(read.producerAttemptId,'preload-w0');
  assert.equal(evidence.trace[0].detail.producerAttemptId,read.producerAttemptId);
  assert.equal(evidence.trace[0].detail.plannedCollectorId,'collector-w1');
  assert.equal(read.staleReason,'PriorWindow');
  assert.equal(evidence.trace[0].detail.staleReason,'PriorWindow');
});

test('an expired exact window does not misreport itself as prior-window fallback', () => {
  const input=structuredClone(ch02);
  input.maxArtifactAge=5;
  input.preloadedArtifacts![0].windowIndex=1;
  const evidence=buildReplayEvidence(input);
  const read=evidence.runs.find(run=>run.jobId==='report-w1')!.reads[0];
  assert.equal(read.state,'Stale');
  assert.equal(read.actualWindowIndex,read.requiredWindow);
  assert.equal(read.staleReason,'ExpiredExact');
  assert.equal(evidence.trace[0].detail.staleReason,'ExpiredExact');
});

test('a successful job with no inputs does not claim a measured Fresh input', () => {
  const evidence=buildReplayEvidence(ch02);
  const collector=evidence.runs.find(run=>run.jobId==='collector-w1')!;
  const report=evidence.runs.find(run=>run.jobId==='report-w1')!;
  assert.equal(collector.completionStatus,'Success');
  assert.deepEqual(collector.reads,[]);
  assert.equal(collector.inputFreshnessStatus,null);
  assert.equal(report.inputFreshnessStatus,'Stale');
});

test('duplicate input slots cannot create ambiguous read identifiers', () => {
  const input: ScenarioConfig = {
    scenarioId:'read-identity', maxArtifactAge:1,
    jobs:[{id:'r',scheduledStart:10,runDuration:1,inputs:[
      {key:'k',requiredWindow:1},{key:'k',requiredWindow:2},{key:'j',requiredWindow:1},
    ]}],
  };
  assert.equal(new Set(simulate(input).runs[0].reads.map(r=>r.readId)).size,3);
  input.jobs[0].inputs.push({key:'k',requiredWindow:1});
  assert.throws(()=>simulate(input), /Duplicate input slot for r/);
});

test('crowded preload order does not alter observed evidence across a live publication', () => {
  const target = { key:'k', requiredWindow:1 };
  const record = (attemptId: string, publishMinute: number, producerValid = true) =>
    ({ key:'k', windowIndex:1, attemptId, publishMinute, producerValid });
  const input: ScenarioConfig = {
    scenarioId:'crowded-lineage', maxArtifactAge:25,
    jobs:[
      {id:'collector', scheduledStart:1, runDuration:17, inputs:[], output:{key:'k',windowIndex:1}},
      {id:'report-early', scheduledStart:5, runDuration:1, inputs:[target]},
      {id:'report-wait', scheduledStart:5, runDuration:2, inputs:[target], waitPolicy:{...target,deadline:25}},
      {id:'report-late', scheduledStart:19, runDuration:1, inputs:[target]},
    ],
    preloadedArtifacts:[
      record('z-tie',10), record('a-tie',10), record('valid-later',21),
      ...Array.from({length:12},(_,i)=>record('invalid-'+i,i+1,false)),
    ],
  };
  const first = simulate(input);
  const read = (id: string) => first.runs.find(run=>run.jobId===id)!.reads[0];
  assert.equal(read('report-early').unavailableReason,'InvalidProducer');
  assert.equal(read('report-wait').producerAttemptId,'a-tie');
  assert.equal(read('report-late').producerAttemptId,'collector');
  input.preloadedArtifacts!.reverse();
  assert.equal(JSON.stringify(simulate(input)),JSON.stringify(first));
  assert.equal(verifyEvidence(JSON.parse(JSON.stringify(buildReplayEvidence(input)))),'crowded-lineage');
});
