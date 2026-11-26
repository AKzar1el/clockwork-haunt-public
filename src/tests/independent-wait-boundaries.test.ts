import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JobDefinition, ScenarioConfig } from '../engine/types.ts';
import { simulate } from '../engine/simulator.ts';
import { formatReplayMinute, waitResolutionLabel } from '../ui/presentation.ts';

const input = { key: 'input', requiredWindow: 1 };
const report: JobDefinition = {
  id: 'report',
  scheduledStart: 486,
  runDuration: 2,
  inputs: [input],
  waitPolicy: { ...input, deadline: 495 },
};

function collector(runDuration: number): JobDefinition {
  return {
    id: 'collector', scheduledStart: 480, runDuration, inputs: [],
    output: { key: input.key, windowIndex: input.requiredWindow },
  };
}

function result(jobs: JobDefinition[]) {
  const config: ScenarioConfig = { scenarioId: 'wait-boundary', maxArtifactAge: 8, jobs };
  return simulate(config);
}

test('completion exactly at the cutoff is allowed', () => {
  const res = result([collector(13), report]);
  const run = res.runs.find((r) => r.jobId === report.id);
  assert.equal(run?.actualStart, 493);
  assert.equal(run?.completionMinute, 495);
  assert.equal(run?.completionStatus, 'Success');
  assert.equal(res.eventLog.filter((e) => e.kind === 'Completion' && e.entityId === report.id).length, 1);
});

test('fresh data at scheduled start does not waive the finish cutoff', () => {
  const run = result([collector(6), { ...report, runDuration: 10 }]).runs.find((r) => r.jobId === report.id);
  assert.equal(run?.actualStart, null);
  assert.equal(run?.completionStatus, 'DeadlineMissed');
  assert.equal(run?.missReason, 'CompletionWouldExceedCutoff');
});

test('the admission event identifies an immediate finish-cutoff miss without claiming a start', () => {
  const checked = result([collector(6),{...report,runDuration:10}]);
  const run = checked.runs.find(record=>record.jobId===report.id)!;
  const events = checked.eventLog.filter(event=>event.entityId===report.id);
  assert.deepEqual(events.map(event=>[event.kind,event.minute,waitResolutionLabel(event.kind,event.minute,run)]),
    [['Admission',486,'Not enough time to start and finish']]);
  const absent = result([{...report,waitPolicy:{...report.waitPolicy!,deadline:486}}]);
  assert.deepEqual(absent.eventLog.map(event=>[event.kind,waitResolutionLabel(event.kind,event.minute,absent.runs[0])]),
    [['Admission',null],['DeadlineMiss','No usable publication by cutoff']]);
});

test('an already present artifact is eligible at the freshness limit without entering a wait', () => {
  const withPublication = (publishMinute: number) => simulate({
    scenarioId:'present-age-boundary',maxArtifactAge:8,jobs:[report],
    preloadedArtifacts:[{key:'input',windowIndex:1,producerValid:true,attemptId:'preload',publishMinute}],
  });
  const fresh = withPublication(478);
  const run = fresh.runs[0];
  assert.deepEqual([run.actualStart,run.completionMinute,run.waitStart,run.waitEnd,run.waitOutcome],
    [486,488,null,null,null]);
  assert.deepEqual([run.reads[0].artifactAge,run.reads[0].publishMinute,run.reads[0].state],[8,478,'Fresh']);
  assert.deepEqual(fresh.eventLog.map(event=>event.kind),['Admission','Completion']);
  const expired = withPublication(477);
  assert.deepEqual([expired.runs[0].actualStart,expired.runs[0].waitStart,expired.runs[0].waitResolutionMinute],
    [null,486,495]);
  const miss = expired.trace.find(trace=>trace.kind==='DeadlineMiss')!;
  assert.equal(miss.detail.artifactAtCutoff,'Expired');
  assert.equal(miss.detail.observedPublishMinute,477);
});

test('deadline rejection identifies observed artifact and timing at admission or wake', () => {
  for (const published of [486, 495]) {
    const checked = result([collector(published-480), { ...report, runDuration:10 }]);
    const failed = checked.trace.find(t=>t.kind==='DeadlineMiss')!;
    assert.equal(failed.eventMinute,published);
    assert.equal(failed.detail.observedPublishMinute,published);
    assert.equal(failed.detail.observedProducerAttemptId,'collector');
    assert.equal(failed.detail.earliestFinish,published+10);
    assert.equal(failed.detail.finishCutoff,495);
    assert.deepEqual(checked.runs.find(run=>run.jobId===report.id)?.reads,[]);
  }
});

test('a wait policy does not admit a run whose ordinary input list is empty', () => {
  const run = result([{ ...report, inputs: [] }]).runs[0];
  assert.equal(run.actualStart, null);
  assert.equal(run.missReason, 'ArtifactNeverPublished');
});

test('fresh policy input releases the wait without concealing a different missing input', () => {
  const missing = {key:'independent',requiredWindow:1};
  const checked = result([collector(13),{...report,inputs:[missing,input]}]);
  const run = checked.runs.find(record=>record.jobId===report.id)!;
  assert.deepEqual([run.waitOutcome,run.actualStart,run.completionMinute,run.completionStatus],
    ['ArtifactArrived',493,495,'Success']);
  assert.deepEqual(run.reads.map(read=>[read.key,read.state,read.producerAttemptId]),[
    ['independent','Missing',null], ['input','Fresh','collector'],
  ]);
  assert.equal(run.inputFreshnessStatus,'Missing');
});

test('matching policy data is never reused for a different window of the same key', () => {
  const checked = simulate({scenarioId:'policy-window-identity',maxArtifactAge:15,
    jobs:[collector(12),{...report,inputs:[{...input,requiredWindow:0},input,{...input,requiredWindow:2}]}],
    preloadedArtifacts:[{key:'input',windowIndex:0,publishMinute:485,attemptId:'prior-window',producerValid:true}],
  });
  const run = checked.runs.find(record=>record.jobId===report.id)!;
  assert.equal(run.policyArtifact?.producerAttemptId,'collector');
  assert.deepEqual(run.reads.map(read=>[read.requiredWindow,read.state,read.producerAttemptId]),[
    [0,'Fresh','prior-window'],[1,'Fresh','collector'],[2,'Missing',null],
  ]);
});

test('policy provenance survives when the gate target is not an ordinary read', () => {
  const reportOnlyWaits = {...report,inputs:[]};
  for (const [published,decision,completed] of [[485,486,488],[492,492,494],[494,494,null]]) {
    const output = result([collector(Number(published)-480),reportOnlyWaits]);
    const run = output.runs.find(record=>record.jobId===report.id)!;
    assert.deepEqual(run.policyArtifact,{key:'input',windowIndex:1,producerAttemptId:'collector',
      publishMinute:published,decisionMinute:decision,ageAtDecision:Number(decision)-Number(published)});
    assert.equal(run.completionMinute,completed);
    assert.deepEqual(run.reads,[]);
    assert.equal(run.inputFreshnessStatus,null);
  }
  assert(!Object.hasOwn(result([reportOnlyWaits]).runs[0],'policyArtifact'));
});

test('zero or fractional run durations are invalid', () => {
  for (const duration of [0, -1, 1.5]) {
    assert.throws(() => result([collector(duration)]), /runDuration must be a positive integer/);
  }
});

test('admission at its own deadline records one miss, not a fictitious wait interval', () => {
  const checked = result([{...report, waitPolicy:{...report.waitPolicy!,deadline:report.scheduledStart}}]);
  assert.equal(checked.runs[0].missReason,'ArtifactNeverPublished');
  assert.equal(checked.runs[0].waitStart,null);
  assert.equal(checked.runs[0].waitResolutionMinute,report.scheduledStart);
  assert.deepEqual(checked.trace.map(t=>t.kind),['DeadlineMiss']);
});

test('an in-day cutoff before admission is a schedule conflict, not an out-of-day value', () => {
  const withDeadline = (deadline: number) => [{ ...report, waitPolicy: { ...report.waitPolicy!, deadline } }];
  assert.throws(() => result(withDeadline(485)), /deadline 485 precedes scheduledStart 486/);
  assert.throws(() => result(withDeadline(1440)), /deadline 1440 out of \[0,1439\]/);
});

test('a hypothetical next-day finish never creates an event outside the replay day', () => {
  const producer = {...collector(1),scheduledStart:1438};
  const consumer = {...report,scheduledStart:1437,waitPolicy:{...report.waitPolicy!,deadline:1439}};
  const checked = result([producer,consumer]);
  const miss = checked.trace.find(trace=>trace.kind==='DeadlineMiss')!;
  assert.equal(miss.eventMinute,1439);
  assert.equal(miss.detail.earliestFinish,1441);
  assert.equal(formatReplayMinute(Number(miss.detail.earliestFinish)),'00:01 next day');
  assert.equal(formatReplayMinute(miss.eventMinute),'23:59');
  assert(checked.eventLog.every(event=>event.minute<=1439));
  assert(!checked.eventLog.some(event=>event.kind==='Completion' && event.entityId===consumer.id));
});

test('a circular wait stops at each own cutoff, but a real seed can break the cycle', () => {
  const jobs: JobDefinition[] = [
    {id:'a',scheduledStart:100,runDuration:2,inputs:[{key:'from-b',requiredWindow:1}],
      waitPolicy:{key:'from-b',requiredWindow:1,deadline:103},output:{key:'from-a',windowIndex:1}},
    {id:'b',scheduledStart:100,runDuration:2,inputs:[{key:'from-a',requiredWindow:1}],
      waitPolicy:{key:'from-a',requiredWindow:1,deadline:106},output:{key:'from-b',windowIndex:1}},
  ];
  const scenario = {scenarioId:'circular-wait',jobs,maxArtifactAge:5};
  const unresolved = simulate(scenario);
  assert.deepEqual(unresolved.runs.map(run=>[run.actualStart,run.waitResolutionMinute,run.missReason]),[
    [null,103,'ArtifactNeverPublished'],[null,106,'ArtifactNeverPublished'],
  ]);
  assert.deepEqual(unresolved.trace.filter(row=>row.kind==='DeadlineMiss').map(row=>row.detail.plannedCollectorId),['b','a']);
  assert.deepEqual(unresolved.slots,[]);
  const seeded = simulate({...scenario,preloadedArtifacts:[
    {key:'from-b',windowIndex:1,publishMinute:99,producerValid:true,attemptId:'seed-b'},
  ]});
  assert.deepEqual(seeded.runs.map(run=>[run.actualStart,run.completionMinute,run.reads[0].producerAttemptId]),[
    [100,102,'seed-b'],[102,104,'a'],
  ]);
  assert.equal(seeded.trace.filter(row=>row.kind==='DeadlineMiss').length,0);
});

test('a wait released by one slot sees all other same-minute commits but not the next minute', () => {
  const main = {key:'main',requiredWindow:1};
  const side = {key:'side',requiredWindow:1};
  const replay = (secondaryMinute: number) => simulate({scenarioId:'cross-slot-wait-view',maxArtifactAge:10,
    preloadedArtifacts:[{key:'side',windowIndex:0,publishMinute:98,attemptId:'prior-side',producerValid:true}],
    jobs:[
      {id:'report',scheduledStart:100,runDuration:2,inputs:[main,side],fallbackEnabled:true,
        waitPolicy:{...main,deadline:107}},
      {id:'z-secondary',scheduledStart:100,runDuration:secondaryMinute-100,inputs:[],output:{key:'side',windowIndex:1}},
      {id:'a-primary',scheduledStart:100,runDuration:5,inputs:[],output:{key:'main',windowIndex:1}},
    ],
  });
  const together = replay(105);
  assert.deepEqual(together.eventLog.filter(e=>e.minute===105).map(e=>[e.kind,e.entityId]),
    [['Completion','a-primary'],['Completion','z-secondary'],['WaitEnd','report']]);
  assert.deepEqual(together.runs[0].reads.map(read=>[read.state,read.producerAttemptId]),
    [['Fresh','a-primary'],['Fresh','z-secondary']]);
  const later = replay(106);
  assert.deepEqual(later.runs[0].reads.map(read=>[read.state,read.producerAttemptId]),
    [['Fresh','a-primary'],['Stale','prior-side']]);
  assert.equal(later.runs[0].completionMinute,107);
  assert.equal(later.trace.find(row=>row.kind==='StaleRead')?.eventMinute,105);
});
