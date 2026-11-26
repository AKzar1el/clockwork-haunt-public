import assert from 'node:assert/strict';
import { test } from 'node:test';
import { simulate } from '../engine/simulator.ts';
import { ch03FailedCollector } from '../fixtures/ch03.ts';
import type { ScenarioConfig } from '../engine/types.ts';

test('a suppressed successful retry cannot refresh expired data or wake a waiting job', () => {
  const target = {key:'result',requiredWindow:1};
  const output = {key:target.key,windowIndex:target.requiredWindow};
  const scenario: ScenarioConfig = {scenarioId:'expired-dedup-wait',maxArtifactAge:1,jobs:[
    {id:'original',scheduledStart:100,runDuration:1,inputs:[],output},
    {id:'retry',scheduledStart:104,runDuration:1,inputs:[],output},
    {id:'consumer',scheduledStart:103,runDuration:1,inputs:[target],waitPolicy:{...target,deadline:107}},
  ]};
  const blocked = simulate(scenario);
  const retryEvent = blocked.eventLog.find(event=>event.kind==='Completion'&&event.entityId==='retry');
  const timedOut = blocked.runs.find(run=>run.jobId==='consumer')!;
  const trace = blocked.trace.find(row=>row.kind==='DeadlineMiss'&&row.reportId==='consumer');
  assert.equal(retryEvent?.completion?.output?.kind,'Suppressed');
  assert.deepEqual([timedOut.completionStatus,timedOut.actualStart,timedOut.policyArtifact],['DeadlineMissed',null,undefined]);
  assert.deepEqual([trace?.detail.artifactAtCutoff,trace?.detail.observedPublishMinute],['Expired',101]);
  assert(!blocked.eventLog.some(event=>event.kind==='WaitEnd'&&event.entityId==='consumer'));
  const accepted = simulate({...scenario,jobs:scenario.jobs.map(job=>({...job,deduplicationEnabled:false}))});
  const resumed = accepted.runs.find(run=>run.jobId==='consumer')!;
  assert.deepEqual([resumed.actualStart,resumed.completionMinute,resumed.policyArtifact?.producerAttemptId],[105,106,'retry']);
  assert.equal(accepted.slots[0].effectCount,2);
});

test('a synthetic failed producer completes without publishing an output effect', () => {
  const result = simulate(ch03FailedCollector);
  const [collector,report] = result.runs;
  assert.equal(collector.completionStatus,'Failure');
  assert.equal(collector.completionMinute,492);
  assert.equal(report.missReason,'ArtifactNeverPublished');
  assert.equal(report.actualStart,null);
  assert.equal(result.slots.length,0);
  assert(!result.eventLog.some(e=>e.kind==='WaitEnd'));
  assert.equal(result.trace.find(t=>t.kind==='DeadlineMiss')?.detail.artifactAtCutoff,'ProducerFailed');
});

test('a failure after cutoff is not retroactively reported at cutoff', () => {
  const config = structuredClone(ch03FailedCollector);
  config.jobs[0].runDuration = 18;
  const result = simulate(config);
  assert.equal(result.runs[0].completionStatus,'Failure');
  assert.equal(result.trace.find(t=>t.kind==='DeadlineMiss')?.detail.artifactAtCutoff,'Absent');
});

test('failure of another candidate is not attributed to the designated planned producer', () => {
  const config = structuredClone(ch03FailedCollector);
  const [collector, report] = config.jobs;
  const primary = { ...collector, id:'a-primary', completionOutcome:'Success' as const,
    waitPolicy:{key:'upstream',requiredWindow:1,deadline:500} };
  const secondary = { ...collector, id:'z-secondary' };
  config.jobs = [secondary, report, primary];
  const miss = () => simulate(config).trace.find(t=>t.kind==='DeadlineMiss' && t.reportId===report.id)?.detail;
  assert.equal(miss()?.plannedCollectorId,'a-primary');
  assert.equal(miss()?.artifactAtCutoff,'Absent');
  config.jobs.reverse();
  assert.equal(miss()?.plannedCollectorId,'a-primary');
  assert.equal(miss()?.artifactAtCutoff,'Absent');
});

test('a failed retry neither erases an earlier valid output nor claims a deduplication attempt', () => {
  const input: ScenarioConfig = {scenarioId:'failed-retry',maxArtifactAge:20,jobs:[
    {id:'ok',scheduledStart:2,runDuration:1,inputs:[],output:{key:'k',windowIndex:1}},
    {id:'failed-retry',scheduledStart:4,runDuration:1,inputs:[],output:{key:'k',windowIndex:1},completionOutcome:'Failure'},
    {id:'reader',scheduledStart:6,runDuration:1,inputs:[{key:'k',requiredWindow:1}]},
  ]};
  const result = simulate(input);
  const slot = result.slots[0];
  assert.deepEqual([slot.attemptCount,slot.effectCount,slot.acceptedEffectId],[1,1,'ok']);
  const retry = result.eventLog.find(event=>event.kind==='Completion' && event.entityId==='failed-retry')!;
  assert.deepEqual(retry.completion,{outcome:'Failure',output:{kind:'Failed',key:'k',windowIndex:1,attemptId:'failed-retry'}});
  assert(!result.trace.some(event=>event.kind==='Suppression'));
  const use = result.runs.find(run=>run.jobId==='reader')!.reads[0];
  assert.deepEqual([use.state,use.producerAttemptId,use.publishMinute],['Fresh','ok',3]);
});

test('a waiter uses the accepted same-minute effect rather than the configured planned producer', () => {
  const output = {key:'delivery',windowIndex:1};
  const target = {key:'delivery',requiredWindow:1};
  const scenario: ScenarioConfig = {
    scenarioId:'same-minute-accepted-lineage',maxArtifactAge:20,
    jobs:[
      {id:'a-plan',scheduledStart:1,runDuration:2,inputs:[],output,
        waitPolicy:{key:'trigger',requiredWindow:1,deadline:12}},
      {id:'z-tied',scheduledStart:4,runDuration:3,inputs:[],output},
      {id:'b-winner',scheduledStart:5,runDuration:2,inputs:[],output},
      {id:'report',scheduledStart:3,runDuration:2,inputs:[target],waitPolicy:{...target,deadline:9}},
    ],
    preloadedArtifacts:[{key:'trigger',windowIndex:1,publishMinute:8,producerValid:true,attemptId:'trigger-8'}],
  };
  for (const jobs of [scenario.jobs,[...scenario.jobs].reverse()]) {
    const result = simulate({...scenario,jobs});
    const report = result.runs.find(run=>run.jobId==='report')!;
    const blocked = result.trace.find(event=>event.kind==='BlockedWait' && event.reportId==='report');
    assert.equal(blocked?.detail.plannedCollectorId,'a-plan');
    assert.deepEqual([report.actualStart,report.completionMinute,report.reads[0].producerAttemptId],[7,9,'b-winner']);
    const minute = result.eventLog.filter(event=>event.minute===7);
    assert.deepEqual(minute.map(event=>[event.kind,event.entityId,event.completion?.output?.kind]),[
      ['Completion','b-winner','Accepted'], ['Completion','z-tied','Suppressed'], ['WaitEnd','report',undefined],
    ]);
    const slot = result.slots[0];
    assert.deepEqual([slot.attemptCount,slot.effectCount,slot.acceptedEffectId],[3,1,'b-winner']);
    assert.deepEqual(slot.suppressedAttempts.map(attempt=>[attempt.attemptId,attempt.acceptedEffectId]),[
      ['z-tied','b-winner'], ['a-plan','b-winner'],
    ]);
  }
});

test('different accepted effects can yield one chosen read without implying a canonical commit', () => {
  const output = {key:'delivery',windowIndex:1};
  const target = {key:'delivery',requiredWindow:1};
  const scenario: ScenarioConfig = {
    scenarioId:'same-minute-independent-effects',maxArtifactAge:0,jobs:[
      {id:'last',scheduledStart:4,runDuration:1,inputs:[],output,deduplicationEnabled:false},
      {id:'first',scheduledStart:3,runDuration:2,inputs:[],output,deduplicationEnabled:false},
      {id:'report',scheduledStart:2,runDuration:1,inputs:[target],waitPolicy:{...target,deadline:6}},
    ],
  };
  const result = simulate(scenario);
  const atPublication = result.eventLog.filter(event=>event.minute===5);
  assert.deepEqual(atPublication.map(event=>[event.entityId,event.completion?.output?.kind]),[
    ['first','Accepted'], ['last','Accepted'], ['report',undefined],
  ]);
  const read = result.runs.find(run=>run.jobId==='report')!.reads[0];
  assert.deepEqual([read.producerAttemptId,read.artifactAge,read.state],['first',0,'Fresh']);
  const slot = result.slots[0];
  assert.deepEqual([slot.attemptCount,slot.effectCount,slot.acceptedEffectId,slot.suppressedAttempts],[2,2,null,[]]);
});
