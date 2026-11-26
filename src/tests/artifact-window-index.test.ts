import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArtifactStore } from '../engine/store.ts';
import type { ArtifactRecord } from '../engine/types.ts';

test('a same-time fallback result or miss cannot survive an intervening publication', () => {
  const store = new ArtifactStore();
  const add = (windowIndex: number, publishMinute: number, attemptId: string) =>
    store.add({key:'shared',windowIndex,publishMinute,attemptId,producerValid:true});
  const at = (target: number, minute = 10) => store.getBestBelow('shared',target,minute)?.attemptId;
  add(3,9,'initial');
  assert.equal(at(3),undefined);
  assert.equal(at(3),undefined);
  add(2,10,'z');
  assert.equal(at(3),'z');
  assert.equal(at(3),'z');
  add(2,10,'a');
  assert.equal(at(3),'a');
  assert.equal(at(3,9),undefined);
  assert.equal(at(4,10),'initial');
});

test('indexed exact reads keep time, validity and lexical tie ordering', () => {
  const store = new ArtifactStore();
  const add = (windowIndex: number, publishMinute: number, attemptId: string, producerValid = true) =>
    store.add({ key: 'hot', windowIndex, publishMinute, attemptId, producerValid });
  for (let i = 1; i <= 500; i++) add(i, 1, 'other');
  add(0, 3, 'valid');
  add(0, 4, 'ignored-invalid', false);
  add(0, 5, 'z');
  add(0, 5, 'a');
  assert.equal(store.get('hot', 0, 4)?.attemptId, 'valid');
  assert.equal(store.get('hot', 0, 5)?.attemptId, 'a');
  assert.equal(store.get('hot', 0, 2), undefined);
  assert.equal(store.getBestBelow('hot', 500, 6)?.windowIndex, 499);
  store.getAll('hot').pop();
  assert.equal(store.getAll('hot').length, 504);
});

test('source and listener references cannot corrupt an indexed artifact', () => {
  const store = new ArtifactStore();
  const input = {key:'k', windowIndex:1, publishMinute:2, attemptId:'a', producerValid:true};
  let notified = false;
  store.onAdd(artifact => {
    notified = true;
    assert(Object.isFrozen(artifact));
    assert.equal(artifact.windowIndex, 1);
  });
  store.add(input);
  input.windowIndex = 9;
  input.publishMinute = 100;
  assert(notified);
  assert.equal(store.get('k', 1, 2)?.publishMinute, 2);
  assert.equal(store.get('k', 9), undefined);
  assert(Object.isFrozen(store.getAll('k')[0]));
});

test('cached fallback order admits new windows without exposing future or invalid records', () => {
  const store = new ArtifactStore();
  const add = (windowIndex: number, publishMinute: number, producerValid = true) =>
    store.add({ key:'k', windowIndex, publishMinute, attemptId:'x', producerValid });
  add(10,1);
  add(1,1);
  assert.equal(store.getBestBelow('k',11,3)?.windowIndex,10);
  add(7,2);
  add(8,2,false);
  add(9,100);
  assert.equal(store.getBestBelow('k',10,3)?.windowIndex,7);
  add(8,4);
  assert.equal(store.getBestBelow('k',10,3)?.windowIndex,7);
  assert.equal(store.getBestBelow('k',10,4)?.windowIndex,8);
  assert.equal(store.getBestBelow('k',10,101)?.windowIndex,9);
  assert.equal(store.getBestBelow('k',1),undefined);
});

test('many same-window attempts agree with a simple oracle before and after insertion', () => {
  const store = new ArtifactStore();
  const supplied: ArtifactRecord[] = [];
  const add = (publishMinute: number, attemptId: string, producerValid: boolean) => {
    const record = {key:'crowded', windowIndex:5, publishMinute, attemptId, producerValid};
    supplied.push(record);
    store.add(record);
  };
  const check = () => {
    for (let minute = -1; minute <= 45; minute++) {
      const expected = supplied.filter(record => record.publishMinute <= minute).sort((a,b) =>
        Number(b.producerValid) - Number(a.producerValid) || b.publishMinute - a.publishMinute ||
        (a.attemptId < b.attemptId ? -1 : a.attemptId > b.attemptId ? 1 : 0))[0];
      assert.deepEqual(store.get('crowded',5,minute), expected);
    }
  };
  for (let i = 299; i >= 0; i--) add((i * 31) % 43, 'attempt-' + i, i % 7 === 0);
  check();
  add(0, '0-tie', true);
  add(44, 'after', true);
  add(45, 'late-invalid', false);
  add(0, '0-tie', true);
  check();
  assert.equal(store.getBestBelow('crowded',6,0)?.attemptId, '0-tie');
  assert.equal(store.getAll('crowded').length, 304);
});

test('an out-of-order valid attempt makes its window visible earlier without leaking later attempts', () => {
  const store = new ArtifactStore();
  const add = (windowIndex: number, publishMinute: number, producerValid: boolean) =>
    store.add({ key: 'k', windowIndex, publishMinute, producerValid, attemptId: String(publishMinute) });
  add(1, 10, true);
  for (let i = 30; i <= 70; i++) add(2, i, true);
  add(2, 5, false);
  assert.equal(store.getBestBelow('k', 3, 20)?.windowIndex, 1);
  add(2, 20, true);
  assert.equal(store.getBestBelow('k', 3, 19)?.windowIndex, 1);
  assert.equal(store.getBestBelow('k', 3, 20)?.publishMinute, 20);
  assert.equal(store.getBestBelow('k', 3, 70)?.publishMinute, 70);
});

test('chronological attempts and equal-minute tail ties preserve both indexed validity groups', () => {
  const store = new ArtifactStore();
  const add = (publishMinute: number, attemptId: string, producerValid = true) =>
    store.add({key:'live',windowIndex:1,publishMinute,attemptId,producerValid});
  for (let i = 10; i < 20; i++) add(i, 'seed-' + i);
  assert.equal(store.get('live',1)?.attemptId,'seed-19'); // Build the live index.
  add(5,'z',false);
  add(6,'z',false);
  add(6,'a',false);
  add(6,'m',false);
  add(21,'z');
  add(21,'a');
  add(21,'m');
  add(20,'middle');
  assert.equal(store.get('live',1,4),undefined);
  assert.equal(store.get('live',1,5)?.attemptId,'z');
  assert.equal(store.get('live',1,9)?.attemptId,'a');
  assert.equal(store.get('live',1,20)?.attemptId,'middle');
  assert.equal(store.get('live',1,21)?.attemptId,'a');
  assert.equal(store.getAll('live').length,18);
});

test('an entirely future key can gain an earlier visible window without leaking invalid or exact slots', () => {
  const store = new ArtifactStore();
  const add = (windowIndex: number, publishMinute: number, producerValid = true) =>
    store.add({key:'future',windowIndex,publishMinute,attemptId:String(windowIndex),producerValid});
  for (let window=0; window<100; window++) add(window,80);
  add(99,4,false);
  assert.equal(store.getBestBelow('future',100,79),undefined);
  add(12,20);
  assert.equal(store.getBestBelow('future',100,19),undefined);
  assert.equal(store.getBestBelow('future',12,20),undefined);
  assert.equal(store.getBestBelow('future',100,20)?.windowIndex,12);
  assert.equal(store.getBestBelow('future',100,80)?.windowIndex,99);
  add(90,2);
  assert.equal(store.getBestBelow('future',100,2)?.windowIndex,90);
});

test('fallback results agree with a validity-and-visibility oracle across interleaved writes', () => {
  const store = new ArtifactStore();
  const records: ArtifactRecord[] = [];
  const add = (record: ArtifactRecord) => {
    records.push(record);
    store.add(record);
  };
  add({key:'mixed',windowIndex:12,publishMinute:0,attemptId:'invalid-only-before-writes',producerValid:false});
  const check = () => {
    for (const key of ['mixed','separate']) {
      for (const window of [-40,-20,0,10,30,42]) {
        for (const time of [0,1,39,79,199,400]) {
          const best = records.filter(r=>r.key===key && r.producerValid && r.windowIndex<window && r.publishMinute<=time)
            .sort((a,b)=>b.windowIndex-a.windowIndex || b.publishMinute-a.publishMinute ||
              (a.attemptId<b.attemptId ? -1 : a.attemptId>b.attemptId ? 1 : 0))[0];
          assert.deepEqual(store.getBestBelow(key,window,time),best);
        }
      }
    }
  };
  check();
  for (let i=0; i<360; i++) {
    add({
      key:i%5===0?'separate':'mixed', windowIndex:(i*37+17)%79-39,
      publishMinute:(i*13+91)%200, attemptId:'sample-'+i, producerValid:i%7!==2,
    });
    if (i%71===0) check();
  }
  add({key:'mixed',windowIndex:-38,publishMinute:0,attemptId:'earlier-publish',producerValid:true});
  check();
});
