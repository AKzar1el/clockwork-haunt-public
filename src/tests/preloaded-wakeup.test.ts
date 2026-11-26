import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScenarioConfig } from '../engine/types.ts';
import { simulate } from '../engine/simulator.ts';

function scenario(producerValid: boolean, publishMinute: number): ScenarioConfig {
  return {
    scenarioId: 'supplied-late-artifact', maxArtifactAge: 0,
    preloadedArtifacts: [{ key: 'k', windowIndex: 1, publishMinute, attemptId: 'supplied', producerValid }],
    jobs: [{
      id: 'r', scheduledStart: 100, runDuration: 2,
      inputs: [{key:'k', requiredWindow:1}], waitPolicy: {key:'k', requiredWindow:1, deadline:106},
    }],
  };
}

test('a supplied artifact wakes a report only when it becomes visible', () => {
  const result = simulate(scenario(true, 104));
  assert.equal(result.runs[0].actualStart, 104);
  assert.equal(result.runs[0].completionMinute, 106);
  assert.deepEqual(result.eventLog.map(e => [e.minute, e.kind]), [[100,'Admission'],[104,'WaitEnd'],[106,'Completion']]);
});

test('multiple supplied attempts at one minute produce one wake and retain lexical selection', () => {
  const config = scenario(true, 104);
  const seed = config.preloadedArtifacts![0];
  config.preloadedArtifacts!.push(
    { ...seed, attemptId:'z-after', publishMinute:107 },
    { ...seed, attemptId:'a-first' },
    { ...seed, attemptId:'invalid-earlier', publishMinute:103, producerValid:false },
    { ...seed, attemptId:'stale-earlier', publishMinute:98 },
  );
  const output = simulate(config);
  assert.equal(output.runs[0].reads[0].producerAttemptId,'a-first');
  assert.deepEqual(output.eventLog.map(e=>[e.minute,e.kind]),[[100,'Admission'],[104,'WaitEnd'],[106,'Completion']]);
  config.preloadedArtifacts!.reverse();
  assert.deepEqual(simulate(config), output);
});

test('supplied publications after the cutoff and invalid publications do not unblock a report', () => {
  for (const config of [scenario(true, 107), scenario(false, 104)]) {
    const result = simulate(config);
    assert.equal(result.runs[0].missReason, 'ArtifactNeverPublished');
    assert.deepEqual(result.runs[0].reads, []);
    assert(!result.trace.some(t => t.kind === 'StaleRead'));
    assert(!result.eventLog.some(e => e.kind === 'WaitEnd'));
  }
});

test('the first supplied wake resolves the wait unless a simulated producer wakes it earlier', () => {
  const config = scenario(true, 104);
  const seed = config.preloadedArtifacts![0];
  config.preloadedArtifacts!.push({ ...seed, attemptId:'at-cutoff', publishMinute:106 });
  assert.deepEqual(simulate(config).eventLog.filter(e=>e.kind==='WaitEnd').map(e=>e.minute),[104]);
  config.jobs.push({id:'collector', scheduledStart:100, runDuration:3, inputs:[], output:{key:'k',windowIndex:1}});
  const earlier = simulate(config);
  assert.deepEqual(earlier.eventLog.filter(e=>e.kind==='WaitEnd').map(e=>e.minute),[103]);
  assert.equal(earlier.runs.find(run=>run.jobId==='r')?.reads[0].producerAttemptId,'collector');
});

test('same-minute supplied and dynamic publications coalesce without losing lexical provenance', () => {
  const config = scenario(true, 104);
  for (const id of ['z-collector','a-collector']) {
    config.jobs.push({id, scheduledStart:100, runDuration:4, inputs:[],
      output:{key:'k',windowIndex:1}, deduplicationEnabled:false});
  }
  const output = simulate(config);
  assert.deepEqual(output.eventLog.filter(e=>e.kind==='WaitEnd').map(e=>e.minute),[104]);
  assert.equal(output.runs.find(run=>run.jobId==='r')?.reads[0].producerAttemptId,'a-collector');
  assert.equal(output.slots[0].effectCount,2);
});

test('the gate records the selected artifact rather than the notifier and excludes unusable cutoff observations', () => {
  const config = scenario(true,104);
  config.preloadedArtifacts![0].attemptId = 'a-supplied';
  config.jobs.push({id:'z-notifier',scheduledStart:100,runDuration:4,inputs:[],
    output:{key:'k',windowIndex:1}});
  const fresh = simulate(config);
  const report = fresh.runs.find(run=>run.jobId==='r')!;
  assert.equal(fresh.slots[0].acceptedEffectId,'z-notifier');
  assert.deepEqual(report.policyArtifact,{key:'k',windowIndex:1,producerAttemptId:'a-supplied',
    publishMinute:104,decisionMinute:104,ageAtDecision:0});
  assert.equal(report.reads[0].producerAttemptId,report.policyArtifact?.producerAttemptId);
  for (const rejected of [scenario(true,107),scenario(true,98),scenario(false,104)]) {
    const miss = simulate(rejected).runs[0];
    assert(!Object.hasOwn(miss,'policyArtifact'));
    assert.equal(miss.missReason,'ArtifactNeverPublished');
  }
});

test('deadline evidence distinguishes absent, expired and invalid output', () => {
  for (const [valid, publication, condition] of [
    [true, 107, 'Absent'], [true, 98, 'Expired'], [false, 104, 'InvalidProducer'],
  ] as const) {
    const result = simulate(scenario(valid, publication));
    const detail = result.trace.find(trace => trace.kind === 'DeadlineMiss')?.detail;
    assert.equal(result.runs[0].missReason,'ArtifactNeverPublished');
    assert.equal(detail?.artifactAtCutoff,condition);
    assert.equal(detail?.observedPublishMinute,condition === 'Absent' ? null : publication);
  }
});

test('a guaranteed supply at cutoff resolves as a timing miss rather than absent data', () => {
  const [atCutoff,afterCutoff] = [scenario(true,106),scenario(true,107)].map(simulate);
  assert.deepEqual(atCutoff.eventLog.map(event=>[event.kind,event.minute]),[['Admission',100],['WaitEnd',106]]);
  assert.equal(atCutoff.runs[0].missReason,'CompletionWouldExceedCutoff');
  assert.equal(atCutoff.runs[0].policyArtifact?.publishMinute,106);
  assert.deepEqual(afterCutoff.eventLog.map(event=>[event.kind,event.minute]),[['Admission',100],['DeadlineMiss',106]]);
  assert.equal(afterCutoff.runs[0].missReason,'ArtifactNeverPublished');
});

test('a dynamic publisher completing after cutoff cannot leave a late waiter event', () => {
  const config = scenario(false,104);
  config.preloadedArtifacts = [];
  config.jobs.push({id:'late-collector',scheduledStart:100,runDuration:7,inputs:[],
    output:{key:'k',windowIndex:1}});
  const checked = simulate(config);
  assert.deepEqual(checked.eventLog.filter(event=>event.entityId==='r').map(event=>[event.kind,event.minute]),
    [['Admission',100],['DeadlineMiss',106]]);
  assert.equal(checked.runs[0].missReason,'ArtifactNeverPublished');
  assert(!checked.runs[0].policyArtifact);
  assert.equal(checked.eventLog.find(event=>event.kind==='Completion')?.completion?.output?.kind,'Accepted');
});

test('large early publication discards only superseded wakes and keeps an unrelated waiter', () => {
  const config = scenario(true,105);
  const template = config.jobs[0];
  config.jobs = Array.from({length:96},(_,i)=>({...template,id:'wait-'+i}));
  const separate = {key:'other',requiredWindow:1};
  config.jobs.push(
    {id:'other',scheduledStart:100,runDuration:1,inputs:[separate],waitPolicy:{...separate,deadline:107}},
    {id:'early',scheduledStart:100,runDuration:3,inputs:[],output:{key:'k',windowIndex:1}},
  );
  config.preloadedArtifacts!.push({key:'other',windowIndex:1,publishMinute:104,attemptId:'other-supply',producerValid:true});
  const checked = simulate(config);
  assert(checked.runs.slice(0,96).every(run=>run.actualStart===103 && run.policyArtifact?.producerAttemptId==='early'));
  assert.equal(checked.runs.find(run=>run.jobId==='other')?.actualStart,104);
  assert.equal(checked.eventLog.filter(event=>event.kind==='WaitEnd'&&event.minute===103).length,96);
  assert.deepEqual(checked.eventLog.filter(event=>event.kind==='WaitEnd'&&event.minute!==103).map(event=>[event.entityId,event.minute]),
    [['other',104]]);
});
