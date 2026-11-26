import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArtifactRecord, JobDefinition, ScenarioConfig } from '../engine/types.ts';
import { simulate } from '../engine/simulator.ts';
import { buildEvidence } from '../export/evidence.ts';
import { ch01 } from '../fixtures/ch01.ts';
import { ch02 } from '../fixtures/ch02.ts';
import { ch03a, ch03b, ch03c } from '../fixtures/ch03.ts';
import { ch04Enabled, ch04Disabled } from '../fixtures/ch04.ts';

const cfg = (jobs: JobDefinition[], preloadedArtifacts: ArtifactRecord[] = [], maxArtifactAge = 20): ScenarioConfig =>
  ({scenarioId:'extended-audit', jobs, preloadedArtifacts, maxArtifactAge});
const artifact = (key: string, windowIndex: number, publishMinute: number, producerValid = true, attemptId = 'preload') =>
  ({key, windowIndex, publishMinute, producerValid, attemptId});
const job = (id: string, scheduledStart: number, runDuration: number, fields: Partial<JobDefinition> = {}): JobDefinition =>
  ({id, scheduledStart, runDuration, inputs:[], ...fields});
const read = (key: string, requiredWindow: number) => ({key, requiredWindow});
const output = (key: string, windowIndex: number) => ({key, windowIndex});
const ordered = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const find = (result: ReturnType<typeof simulate>, id: string) => result.runs.find(r => r.jobId === id)!;
const planned = (r: ReturnType<typeof simulate>, kind: string) => r.trace.find(x => x.kind === kind)?.detail.plannedCollectorId;
const cases = [ch01,ch02,ch03a,ch03b,ch03c,ch04Enabled,ch04Disabled];
const run = (id: number, title: string, check: () => void) => test('Audit ' + String(id).padStart(4,'0') + ': ' + title, check);

for (let i=0;i<100;i++) {
  const arrival = 480 + Math.floor(i/10), duration = 1 + i%10, start = 484, deadline = 488;
  run(101+i, 'cutoff boundary: arrival ' + arrival + ', duration ' + duration, () => {
    const producer = job('producer',470,arrival-470,{output:output('k',9)});
    const consumer = job('report',start,duration,{inputs:[read('k',9)],waitPolicy:{...read('k',9),deadline}});
    const actual = find(simulate(cfg([consumer,producer])), 'report');
    const begin = Math.max(start,arrival);
    const finish = begin+duration;
    if (finish<=deadline) {
      assert.deepEqual([actual.actualStart,actual.completionMinute,actual.inputFreshnessStatus],[begin,finish,'Fresh']);
    } else {
      assert.equal(actual.actualStart,null);
      assert.equal(actual.missReason,arrival>deadline?'ArtifactNeverPublished':'CompletionWouldExceedCutoff');
      assert.equal(actual.waitEnd,arrival>deadline?null:arrival);
      assert.equal(actual.waitResolutionMinute,arrival>deadline?deadline:begin);
    }
  });
}

for (let i=0;i<100;i++) {
  const age = i%10, mode = Math.floor(i/10), time=200;
  run(201+i, 'artifact visibility: case ' + mode + ', age ' + age, () => {
    const exact = artifact('k',3,time-age);
    const fallback = artifact('k',2,time-age);
    const futureExact = artifact('k',3,time+1+age);
    const futurePrior = artifact('k',2,time+1+age);
    const old = artifact('k',1,time-age);
    const invalid = artifact('k',3,time-age,false);
    const ancient = artifact('k',3,time-age-10);
    const records = [
      [exact], [ancient,exact], [invalid,exact], [futureExact,fallback],
      [futurePrior,old], [invalid,fallback], [futureExact], [fallback],
      [ancient], [artifact('x',3,time-age),fallback],
    ][mode];
    const enabled = mode!==7;
    const next = mode===6 ? {'k:3':time+1+age} : undefined;
    const observed = find(simulate(cfg([job('r',time,1,{inputs:[read('k',3)],fallbackEnabled:enabled,scheduledPublishMinutes:next})],records,4)),'r').reads[0];
    const expected = mode<=2 ? (age<=4?'Fresh':'Stale') : ['Stale','Stale','Unknown','Unknown','Missing','Stale','Stale'][mode-3];
    assert.equal(observed.state,expected);
    if (mode===3||mode===4||mode===9) assert.equal(observed.actualWindowIndex,mode===4?1:2);
    if (mode<=4||mode===9) assert.equal(observed.artifactAge,age);
  });
}

for (let i=0;i<100;i++) {
  const count=2+i%10, pattern=Math.floor(i/10), enabled=pattern%2===0;
  run(301+i, 'slot commits: ' + count + ' producers, pattern ' + pattern, () => {
    const jobs = Array.from({length:count},(_,j)=>job('writer-'+String(j).padStart(2,'0'),120+(j*pattern)%5,1,{output:output('out',j%2),deduplicationEnabled:enabled})).reverse();
    const result = simulate(cfg(jobs));
    for (const w of [0,1]) {
      const eligible = jobs.filter(j=>j.output?.windowIndex===w)
        .sort((a,b)=>a.scheduledStart-b.scheduledStart||ordered(a.id,b.id));
      const slot = result.slots.find(s=>s.windowIndex===w)!;
      assert.equal(slot.attemptCount,eligible.length);
      assert.equal(slot.effectCount,enabled?1:eligible.length);
      assert.deepEqual(slot.suppressedAttempts.map(s=>s.attemptId),enabled?eligible.slice(1).map(x=>x.id):[]);
      if(enabled) assert.equal(slot.acceptedEffectId,eligible[0].id);
    }
  });
}

for (let i=0;i<100;i++) {
  const waiters=2+i%10, release=210+Math.floor(i/10);
  run(401+i, 'indexed wakeup: ' + waiters + ' reports, publication ' + release, () => {
    const reports=Array.from({length:waiters},(_,j)=>{
      const name=j%2?'other':'target', window=j%3===0?2:1;
      return job('report-'+j,203,2,{inputs:[read(name,window)],waitPolicy:{...read(name,window),deadline:225}});
    });
    const publishers=[job('target-one',200,release-200,{output:output('target',1)}),job('target-two',200,release-200,{output:output('target',2)})];
    const result=simulate(cfg([...reports,...publishers]));
    for(const r of reports) {
      const actual=find(result,r.id);
      const released=r.waitPolicy?.key==='target';
      assert.equal(actual.completionMinute,released?release+2:null);
      assert.equal(result.eventLog.filter(e=>e.entityId===r.id&&e.kind==='WaitEnd').length,released?1:0);
      assert.equal(actual.missReason,released?null:'ArtifactNeverPublished');
    }
  });
}

for (let i=0;i<100;i++) {
  const base=300+i%10, pattern=Math.floor(i/10), published=base+4+pattern%4;
  run(501+i, 'trace lineage: base ' + base + ', layout ' + pattern, () => {
    const blocker = job('p-primary',base-5,published-(base-5),{output:output('primary',1)});
    const z = job('z-source',base,published-base+3,{output:output('secondary',3)});
    const a = job('a-source',base,published-base+3+(pattern%2),{output:output('secondary',3)});
    const r = job('report',base,1,{inputs:[read('primary',1),read('secondary',3)],fallbackEnabled:true,waitPolicy:{...read('primary',1),deadline:base+12}});
    const initial=[artifact('secondary',2,base-8)];
    const jobs=pattern%2?[r,a,blocker,z]:[z,r,blocker,a];
    const result=simulate(cfg(jobs,initial));
    assert.equal(planned(result,'BlockedWait'),'p-primary');
    const stale=result.trace.find(t=>t.kind==='StaleRead')!;
    assert.deepEqual([stale.eventMinute,stale.detail.key,stale.detail.fallbackWindow,stale.detail.publishMinute],[published,'secondary',2,base-8]);
    assert.equal(stale.detail.plannedCollectorId,pattern%2?'z-source':'a-source');
    assert.equal(stale.detail.readId,find(result,'report').reads[1].readId);
    assert.equal(stale.detail.state,'Stale');
    assert.equal(planned(simulate(cfg(jobs.toReversed(),initial)),'StaleRead'),stale.detail.plannedCollectorId);
});
}

for (let i=0;i<100;i++) {
  const target=i%cases.length, delay=1+Math.floor(i/cases.length);
  run(601+i, 'evidence round-trip: source ' + cases[target].scenarioId + ', collector shift ' + delay, () => {
    const input=structuredClone(cases[target]);
    input.scenarioId += '-export-'+delay;
    input.jobs=input.jobs.map(j=>j.output?{...j,runDuration:j.runDuration+delay}:j);
    const original=simulate(input);
    const saved=JSON.parse(JSON.stringify(buildEvidence(original,input)));
    assert.equal(saved.schemaVersion,1);
    assert.deepEqual(simulate(saved.input),original);
    assert.deepEqual(saved.runs,original.runs);
    assert(!Object.hasOwn(saved,'timestamp'));
    saved.input.jobs[0].id='mutated';
    assert.notEqual(input.jobs[0].id,saved.input.jobs[0].id);
  });
}

for (let i=0;i<100;i++) {
  const n=i%20, kind=Math.floor(i/20);
  run(701+i, 'boundary validation: category ' + kind + ', value ' + n, () => {
    const basic=job('a',100,1);
    if(kind===0) assert.throws(()=>simulate(cfg([basic,job('a',101+n,1)])),/duplicate job ID/);
    else if(kind===1) assert.throws(()=>simulate(cfg([basic],[artifact('k',1,1440+n)])),/Preloaded publishMinute/);
    else if(kind===2) assert.throws(()=>simulate(cfg([{...basic,scheduledPublishMinutes:{'k:0':-1-n}}])),/Scheduled publish minute/);
    else if(kind===3) assert.throws(()=>simulate(cfg([basic],[],-1-n)),/maxArtifactAge/);
    else assert.throws(()=>simulate(cfg([
      job('a',100+n,1,{output:output('shared',n),deduplicationEnabled:true}),
      job('b',101+n,1,{output:output('shared',n),deduplicationEnabled:false}),
    ])),/conflicting deduplication policy/);
  });
}

for (let i=0;i<100;i++) {
  const n=30+i*5, stride=2+i%23;
  run(801+i,'scheduler oracle: '+n+' jobs, stride '+stride,()=>{
    const jobs=Array.from({length:n},(_,j)=>job('j'+j,(j*stride)%701,1+(j%7))).reverse();
    const result=simulate(cfg(jobs));
    const expected=jobs.flatMap(j=>[
      [j.scheduledStart,2,j.id] as const,[j.scheduledStart+j.runDuration,1,j.id] as const,
    ]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]||ordered(a[2],b[2]));
    assert.deepEqual(result.eventLog.map(e=>[e.minute,e.typePriority,e.entityId]),expected);
    assert.equal(result.runs.filter(r=>r.completionStatus==='Success').length,n);
  });
}

for (let i=0;i<100;i++) {
  const fixture=cases[i%cases.length], delta=(i%2?-1:1)*(1+Math.floor(i/cases.length))*5;
  run(901+i,'time translation: '+fixture.scenarioId+' shifted '+delta+' min',()=>{
    const translated: ScenarioConfig={
      ...fixture,
      preloadedArtifacts: fixture.preloadedArtifacts?.map(r=>({...r,publishMinute:r.publishMinute+delta})),
      jobs: fixture.jobs.map(j=>({
        ...j,scheduledStart:j.scheduledStart+delta,
        waitPolicy:j.waitPolicy && {...j.waitPolicy,deadline:j.waitPolicy.deadline+delta},
        scheduledPublishMinutes:j.scheduledPublishMinutes && Object.fromEntries(Object.entries(j.scheduledPublishMinutes).map(([k,v])=>[k,v+delta])),
      })),
    };
    const before=simulate(fixture), after=simulate(translated);
    const time=(t:number|null)=>t===null?null:t+delta;
    assert.deepEqual(after.runs.map(r=>[r.actualStart,r.completionMinute,r.completionStatus,r.inputFreshnessStatus,r.missReason]),
      before.runs.map(r=>[time(r.actualStart),time(r.completionMinute),r.completionStatus,r.inputFreshnessStatus,r.missReason]));
    assert.deepEqual(after.runs.flatMap(r=>r.reads.map(x=>x.artifactAge)),before.runs.flatMap(r=>r.reads.map(x=>x.artifactAge)));
    assert.deepEqual(after.eventLog.map(e=>[e.minute,e.kind,e.entityId]),before.eventLog.map(e=>[e.minute+delta,e.kind,e.entityId]));
  });
}
