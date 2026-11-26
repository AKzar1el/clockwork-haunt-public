import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildQueue, EventQueue, makeEntry } from '../engine/scheduler.ts';

test('cutoff checks are conditional work, not assumed by the initial scheduler', () => {
  const queue = buildQueue({scenarioId:'only-initial-admissions',maxArtifactAge:0,jobs:[
    {id:'waiter',scheduledStart:10,runDuration:1,inputs:[],waitPolicy:{key:'data',requiredWindow:1,deadline:10}},
    {id:'normal',scheduledStart:10,runDuration:1,inputs:[]},
  ]});
  assert.deepEqual([queue.pop(),queue.pop(),queue.pop()].map(event=>event && [event.kind,event.jobId]),[
    ['Admission','normal'],['Admission','waiter'],undefined,
  ]);
});

test('bulk heap initialization and later pushes preserve one shared ordering', () => {
  const events = Array.from({length:819}, (_,i) =>
    makeEntry((i*107)%1399, 2, 'job'+i, 'Admission', null, 'job'+i)).reverse();
  const queue = new EventQueue(events);
  const completed = makeEntry(0, 1, 'new', 'Completion', null, 'new');
  queue.push(completed);
  const sorted = [completed, ...events].map(x=>x.sortKey).sort();
  assert.deepEqual(sorted.map(()=>queue.pop()?.sortKey), sorted);
  assert.equal(queue.pop(), undefined);
  assert.throws(()=> new EventQueue([completed,completed]), /duplicate event key/);
});

test('discarding obsolete queued work preserves order and does not recycle event keys', () => {
  const entries = Array.from({length:20},(_,i)=>makeEntry(29-i,2,'job-'+i,'Admission',null,'job-'+i));
  const queue = new EventQueue(entries);
  queue.discardPendingWhere(entry=>entry.minute%3===0);
  const remain = entries.filter(entry=>entry.minute%3!==0).sort((a,b)=>a.minute-b.minute);
  assert.equal(queue.pendingCount,remain.length);
  assert.deepEqual(remain.map(()=>queue.pop()),remain);
  assert.equal(queue.pop(),undefined);
  assert.throws(()=>queue.push(entries.find(entry=>entry.minute%3===0)!),/duplicate event key/);
});

test('clock and phase ordering agrees with an independent tuple oracle', () => {
  const events = [0,9,10,99,100,999,1000,1439].flatMap(minute=>
    ([1,2,3,4] as const).flatMap(phase=>
      ['Z','a','a:next','Š','é','e\u0301'].map(id=>makeEntry(minute,phase,id,
        ['Completion','Admission','WaitEnd','DeadlineMiss'][phase-1],phase===3 ? {tPub:minute} : null,id))));
  const tupleSort = (a: typeof events[number], b: typeof events[number]) =>
    a.minute-b.minute || a.typePriority-b.typePriority ||
    (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0);
  const scrambled = [...events].reverse();
  const queue = new EventQueue(scrambled.filter((_,i)=>i%2===0));
  for (const event of scrambled.filter((_,i)=>i%2!==0)) queue.push(event);
  assert.deepEqual(events.sort(tupleSort).map(()=>queue.pop()), events);
  assert.equal(queue.pop(),undefined);
});

test('queued events preserve sort identity and wait payload independently of caller mutations', () => {
  const seed = makeEntry(6,3,'a','WaitEnd',{tPub:6},'a');
  const raw = { ...seed, payload:{tPub:6} };
  const next = makeEntry(7,3,'b','WaitEnd',{tPub:7},'b');
  const queue = new EventQueue([next]);
  queue.push(raw);
  raw.sortKey = '9999:3:a';
  raw.payload.tPub = 99;
  const popped = queue.pop()!;
  assert.deepEqual(popped,seed);
  assert(Object.isFrozen(popped) && Object.isFrozen(popped.payload));
  assert.equal(queue.pop(),next);
});

test('queue rejects invalid event times and fabricated keys before tracking identity', () => {
  const event = makeEntry(6,2,'job','Admission',null,'job');
  const queue = new EventQueue([event]);
  assert.throws(()=>queue.push({...event,sortKey:'0005:2:job'}),/sort key does not match/);
  assert.throws(()=>queue.push(makeEntry(1440,2,'outside','Admission',null,'outside')),/minute or phase out of range/);
  assert.equal(queue.pop(),event);
  assert.equal(queue.pop(),undefined);
});

test('wait events cannot smuggle a different publication time or priority', () => {
  const queue = new EventQueue();
  assert.throws(()=>queue.push(makeEntry(20,3,'report','WaitEnd',{tPub:19},'report')),/wait wake must match/);
  assert.throws(()=>queue.push(makeEntry(20,2,'report','WaitEnd',{tPub:20},'report')),/wait wake must match/);
  assert.throws(()=>queue.push(makeEntry(20,3,'report','WaitEnd',null,'report')),/wait wake must match/);
  queue.push(makeEntry(20,3,'report','WaitEnd',{tPub:20},'report'));
  assert.equal(queue.pop()?.minute,20);
});

test('queue rejects a kind in the wrong phase and cannot dispatch the wrong job', () => {
  const valid = makeEntry(20,1,'publisher','Completion',null,'publisher');
  const wrongPhase = makeEntry(20,2,'publisher','Completion',null,'publisher');
  const wrongJob = { ...valid,jobId:'different-job' };
  const queue = new EventQueue();
  assert.throws(()=>new EventQueue([wrongPhase]),/event kind and phase/);
  assert.throws(()=>queue.push(wrongJob),/event entity must match its job/);
  assert.throws(()=>queue.push({...valid,kind:'Unknown'}),/event kind and phase/);
  assert.throws(()=>queue.push({...valid,payload:{tPub:20}}),/payload only for a wait wake/);
  queue.push(valid);
  assert.equal(queue.pop(),valid);
});
