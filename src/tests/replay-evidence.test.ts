import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEvidence, buildReplayEvidence, evidenceFromReplay, evaluateReplay } from '../export/evidence.ts';
import { simulate } from '../engine/simulator.ts';
import { ch01 } from '../fixtures/ch01.ts';
import { ch02 } from '../fixtures/ch02.ts';
import { ch03ExpiredInput, ch03FailedCollector } from '../fixtures/ch03.ts';
import { ch04Enabled, ch04Disabled } from '../fixtures/ch04.ts';
import type { ScenarioConfig } from '../engine/types.ts';
import { verifyEvidence } from '../../scripts/verify-evidence.mjs';

test('expired input preset keeps its observed publication but never claims a read or wake', () => {
  const bundle = JSON.parse(JSON.stringify(buildReplayEvidence(ch03ExpiredInput)));
  assert.equal(verifyEvidence(bundle),'CH-03e');
  const record = bundle.runs[0];
  assert.deepEqual([record.actualStart,record.waitResolutionMinute,record.reads],[null,495,[]]);
  assert.equal(Object.hasOwn(record,'policyArtifact'),false);
  assert(!bundle.eventLog.some((event: {kind:string})=>event.kind==='WaitEnd'));
  const miss = bundle.trace.find((entry: {kind:string})=>entry.kind==='DeadlineMiss');
  assert.deepEqual([miss.detail.artifactAtCutoff,miss.detail.observedPublishMinute],['Expired',460]);
});

test('a replay export derives evidence from its own cloned inputs', () => {
  const input = structuredClone(ch02);
  const bundle = buildReplayEvidence(input);
  input.jobs[0].runDuration += 8;
  const rerun = simulate(bundle.input!);
  assert.deepEqual(bundle.eventLog, rerun.eventLog);
  assert.deepEqual(bundle.runs, rerun.runs);
  assert.notEqual(bundle.input?.jobs[0].runDuration, input.jobs[0].runDuration);
});

test('the stored replay can serialize its displayed run and input without recomputing from the fixture', () => {
  const fixture = structuredClone(ch02);
  const rendered = evaluateReplay(fixture);
  fixture.jobs[1].runDuration = 5;
  const bundle = evidenceFromReplay(rendered);
  assert.equal(bundle.runs,rendered.result.runs);
  assert.equal(bundle.input,rendered.input);
  assert.equal(bundle.input!.jobs[1].runDuration,2);
  assert.deepEqual(simulate(bundle.input!),rendered.result);
});

test('evidence rejects input from a different scenario', () => {
  assert.throws(() => buildEvidence(simulate(ch01), ch02), /does not match/);
});

test('replay export refuses metadata that cannot survive the offline JSON format', () => {
  const cyclic = { self: null as unknown };
  cyclic.self = cyclic;
  let deep: unknown = null;
  for (let i = 0; i < 31; i++) deep = { child:deep };
  for (const metadata of [cyclic, 1n, new Date(0), new Map(), Number.POSITIVE_INFINITY, deep, [undefined]]) {
    const input = { ...ch01, metadata };
    assert.throws(() => buildReplayEvidence(input), /Replay input must use finite, acyclic JSON data within the offline depth limit/);
  }
  const withFunction = { ...ch01, metadata:() => null };
  const withCycle = { ...ch01, metadata:cyclic };
  assert.throws(() => buildReplayEvidence(withFunction), /Replay input must use finite/);
  assert.throws(() => buildEvidence(simulate(ch01), withCycle), /Replay input must use finite/);
  const shared = { note:'review', flags:[true,null] };
  const input = { ...ch01, metadata:{ one:shared, two:shared, optional:undefined } };
  const exported = JSON.parse(JSON.stringify(buildReplayEvidence(input)));
  assert.deepEqual(exported.input.metadata, {one:shared,two:shared});
  assert.equal(verifyEvidence(exported),ch01.scenarioId);
  const withinLimit = { ...ch01, metadata:(deep as {child:unknown}).child };
  assert.equal(verifyEvidence(JSON.parse(JSON.stringify(buildReplayEvidence(withinLimit)))),ch01.scenarioId);
});

test('owned gate provenance cannot be rewritten by an edited source or a later run', () => {
  const target = {key:'input',requiredWindow:1};
  const fixture: ScenarioConfig = {
    scenarioId:'retained-gate',maxArtifactAge:10,
    preloadedArtifacts:[{key:'input',windowIndex:1,publishMinute:3,attemptId:'prior',producerValid:true}],
    jobs:[{id:'report',scheduledStart:5,runDuration:1,inputs:[],waitPolicy:{...target,deadline:8}}],
  };
  const retained = evaluateReplay(fixture);
  const gate = retained.result.runs[0].policyArtifact!;
  assert(Object.isFrozen(gate));
  assert.equal(Reflect.set(gate,'producerAttemptId','rewritten'),false);
  fixture.preloadedArtifacts![0].attemptId = 'later-edit';
  assert.equal(evaluateReplay(fixture).result.runs[0].policyArtifact?.producerAttemptId,'later-edit');
  assert.deepEqual(simulate(retained.input),retained.result);
  assert.equal(evidenceFromReplay(retained).runs[0].policyArtifact?.producerAttemptId,'prior');
  assert.equal(gate.ageAtDecision,2);
});

test('single-snapshot exports preserve canonical download bytes without shared input', () => {
  const input = structuredClone(ch02);
  const before = JSON.stringify(buildEvidence(simulate(input), input));
  const replay = buildReplayEvidence(input);
  assert.equal(JSON.stringify(replay),before);
  replay.input!.jobs[0].id = 'edited copy';
  assert.notEqual(replay.input!.jobs[0].id,input.jobs[0].id);
});

test('shared immutable gate evidence does not mix different artifacts or decision minutes', () => {
  const fixture: ScenarioConfig = {
    scenarioId:'gate-observation-identity',maxArtifactAge:10,
    preloadedArtifacts:[0,1].map(windowIndex=>({
      key:'input',windowIndex,publishMinute:3,attemptId:'source-'+windowIndex,producerValid:true,
    })),
    jobs:[['a',5,0],['b',5,0],['c',5,1],['d',6,0]].map(([id,start,window])=>({
      id:String(id),scheduledStart:Number(start),runDuration:1,inputs:[],
      waitPolicy:{key:'input',requiredWindow:Number(window),deadline:10},
    })),
  };
  const results = simulate(fixture).runs.map(run=>run.policyArtifact!);
  assert.equal(results[0],results[1]);
  assert(Object.isFrozen(results[0]));
  assert.notEqual(results[0],results[2]);
  assert.notEqual(results[0],results[3]);
  assert.deepEqual(results.map(gate=>[gate.windowIndex,gate.producerAttemptId,gate.ageAtDecision]),[
    [0,'source-0',2],[0,'source-0',2],[1,'source-1',2],[0,'source-0',3],
  ]);
});

test('completion evidence records actual effects instead of inferring them from job definitions', () => {
  const completions = (config: typeof ch01) => buildReplayEvidence(config).eventLog
    .filter(event=>event.kind==='Completion').map(event=>[event.entityId,event.completion] as const);
  const [accepted,suppressed] = completions(ch04Enabled);
  assert.deepEqual(accepted,['attempt-1',{outcome:'Success',output:{kind:'Accepted',attemptId:'attempt-1',key:'result',windowIndex:1}}]);
  assert.deepEqual(suppressed,['attempt-2',{outcome:'Success',output:{kind:'Suppressed',attemptId:'attempt-2',key:'result',windowIndex:1,acceptedEffectId:'attempt-1'}}]);
  assert.deepEqual(completions(ch04Disabled).map(([,record])=>record?.output?.kind),['Accepted','Accepted']);
  assert.deepEqual(completions(ch03FailedCollector), [['collector-w1',{outcome:'Failure',
    output:{kind:'Failed',attemptId:'collector-w1',key:'data',windowIndex:1}}]]);
  assert.deepEqual(completions(ch01).find(([id])=>id==='report-w1')?.[1],{outcome:'Success',output:null});
});

test('slot counts, completion evidence and suppression trace agree with a schedule oracle', () => {
  const input: ScenarioConfig = {
    scenarioId:'multi-slot-effects', maxArtifactAge:0,
    jobs:Array.from({length:28},(_,index)=>({
      id:'attempt-' + String(index).padStart(2,'0'), scheduledStart:10+(index*5)%7, runDuration:2,
      inputs:[], output:{key:'out',windowIndex:index%3}, deduplicationEnabled:index%3!==2,
      completionOutcome:index%5===0 ? 'Failure' : 'Success',
    })).reverse(),
  };
  const evidence = buildReplayEvidence(input);
  for (const window of [0,1,2]) {
    const timeline = input.jobs.filter(job=>job.output?.windowIndex===window).sort((a,b)=>
      a.scheduledStart-b.scheduledStart || (a.id<b.id ? -1 : a.id>b.id ? 1 : 0));
    const commits = timeline.filter(job=>job.completionOutcome==='Success');
    const single = window!==2;
    const canonical = single ? commits[0].id : null;
    const slot = evidence.slots.find(value=>value.windowIndex===window)!;
    assert.deepEqual([slot.attemptCount,slot.effectCount,slot.acceptedEffectId],
      [commits.length,single ? 1 : commits.length,canonical]);
    for (const job of timeline) {
      const effect = evidence.eventLog.find(e=>e.kind==='Completion' && e.entityId===job.id)?.completion?.output;
      const expected = job.completionOutcome==='Failure' ? 'Failed' : single && job.id!==canonical ? 'Suppressed' : 'Accepted';
      assert.equal(effect?.kind,expected);
      assert.equal(effect?.attemptId,job.id);
      const traced = evidence.trace.find(value=>value.kind==='Suppression' && value.reportId===job.id);
      if (expected==='Suppressed') {
        assert(effect?.kind==='Suppressed');
        assert.equal(effect.acceptedEffectId,canonical);
        assert.equal(traced?.detail.acceptedEffectId,canonical);
      } else {
        assert.equal(traced,undefined);
      }
    }
  }
});

test('planned producer changes preserve default dedup agreement and reject a losing conflict', () => {
  const output = {key:'shared',windowIndex:0};
  const producer = (id:string, scheduledStart:number, deduplicationEnabled?:boolean): ScenarioConfig['jobs'][number] => ({
    id, scheduledStart, runDuration:1, inputs:[], output, deduplicationEnabled,
  });
  const fixture: ScenarioConfig = {
    scenarioId:'mixed-policy-plans', maxArtifactAge:0,
    jobs:[
      producer('z-later',8),
      producer('b-earlier',4,true),
      producer('a-earlier',4),
      {id:'independent',scheduledStart:4,runDuration:1,inputs:[],output:{...output,windowIndex:1},deduplicationEnabled:false},
      {id:'report',scheduledStart:3,runDuration:1,inputs:[],waitPolicy:{key:output.key,requiredWindow:output.windowIndex,deadline:6}},
    ],
  };
  const observed = simulate(fixture);
  assert.equal(observed.trace.find(entry=>entry.kind==='BlockedWait')?.detail.plannedCollectorId,'a-earlier');
  const slot = observed.slots.find(item=>item.windowIndex===0);
  assert.deepEqual([slot?.effectCount,slot?.acceptedEffectId],[1,'a-earlier']);
  assert.equal(simulate({...fixture,jobs:fixture.jobs.toReversed()}).trace.find(entry=>entry.kind==='BlockedWait')?.detail.plannedCollectorId,'a-earlier');
  const conflict = producer('x-losing-conflict',10,false);
  for (const jobs of [[...fixture.jobs,conflict],[conflict,...fixture.jobs]]) {
    assert.throws(()=>simulate({...fixture,jobs}),/conflicting deduplication policy/);
  }
});

test('a later suppressed completion cannot replace a published artifact for a reader', () => {
  for (const deduplicationEnabled of [true,false]) {
    const output = {key:'result',windowIndex:0};
    const fixture: ScenarioConfig = {
      scenarioId:'read-after-duplicate-attempt',maxArtifactAge:10,
      jobs:[
        {id:'first',scheduledStart:1,runDuration:1,inputs:[],output,deduplicationEnabled},
        {id:'later',scheduledStart:3,runDuration:1,inputs:[],output,deduplicationEnabled},
        {id:'reader',scheduledStart:4,runDuration:1,inputs:[{key:output.key,requiredWindow:output.windowIndex}]},
      ],
    };
    const result = simulate(fixture);
    const read = result.runs.find(run=>run.jobId==='reader')?.reads[0];
    assert.deepEqual([read?.producerAttemptId,read?.publishMinute,read?.artifactAge],
      deduplicationEnabled ? ['first',2,2] : ['later',4,0]);
    assert.equal(result.eventLog.find(row=>row.kind==='Completion' && row.entityId==='later')?.completion?.output?.kind,
      deduplicationEnabled ? 'Suppressed' : 'Accepted');
  }
});

test('wait decisions distinguish a shared slot from another window and reevaluate at a later minute', () => {
  const report = (id:string, scheduledStart:number, requiredWindow:number): ScenarioConfig['jobs'][number] => ({
    id,scheduledStart,runDuration:1,inputs:[],waitPolicy:{key:'data',requiredWindow,deadline:14},
  });
  const result = simulate({
    scenarioId:'shared-gate-scope',maxArtifactAge:0,
    preloadedArtifacts:[{key:'data',windowIndex:1,attemptId:'preload',producerValid:true,publishMinute:10}],
    jobs:[
      report('a',10,1),report('b',10,1),
      report('c-other-window',10,2),
      report('d-after-expiry',11,1),report('e-after-expiry',11,1),
      {id:'producer',scheduledStart:11,runDuration:1,inputs:[],output:{key:'data',windowIndex:1}},
    ],
  });
  assert.deepEqual(result.runs.slice(0,5).map(run=>[run.actualStart,run.policyArtifact?.producerAttemptId,run.waitOutcome]),[
    [10,'preload',null],[10,'preload',null],[null,undefined,'DeadlineMissed'],
    [12,'producer','ArtifactArrived'],[12,'producer','ArtifactArrived'],
  ]);
});
