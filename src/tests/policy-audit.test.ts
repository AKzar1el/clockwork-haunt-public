import assert from 'node:assert/strict';
import { test } from 'node:test';
import { comparePolicies, evaluatePolicyComparison, policyInputs, selectComparisonRuns, POLICY_ARRIVAL, POLICY_EXAMPLES } from '../fixtures/policy-comparison.ts';
import { ch02, lateWithoutFallback } from '../fixtures/ch02.ts';
import { simulate } from '../engine/simulator.ts';
import { buildComparisonEvidence, buildEvidence, buildReplayEvidence, evidenceFromComparison } from '../export/evidence.ts';
import { EventQueue, makeEntry } from '../engine/scheduler.ts';
import { comparePolicySummary } from '../ui/presentation.ts';

test('the counterfactual sets both report policies instead of inheriting a preset choice', () => {
  const report = ch02.jobs.find(job=>job.id==='report-w1')!;
  const before = buildComparisonEvidence(492);
  const savedFallback = report.fallbackEnabled;
  const savedWait = report.waitPolicy;
  try {
    report.fallbackEnabled = false;
    report.waitPolicy = {...report.inputs[0],deadline:487};
    const comparison = buildComparisonEvidence(492);
    const scheduled = comparison.runOnSchedule.runs.find(run=>run.jobId===report.id);
    const waiting = comparison.waitForFresh.runs.find(run=>run.jobId===report.id);
    assert.equal(scheduled?.actualStart,486);
    assert.equal(scheduled?.inputFreshnessStatus,'Stale');
    assert.equal(waiting?.completionMinute,494);
    assert.deepEqual(comparison,before);
  } finally {
    report.fallbackEnabled = savedFallback;
    if (savedWait === undefined) delete report.waitPolicy;
    else report.waitPolicy = savedWait;
  }
});
test('comparison evaluation preserves each branch’s replay bytes without sharing input', () => {
  const arrival = 492;
  const input = policyInputs(arrival);
  const exported = buildComparisonEvidence(arrival);
  assert.equal(JSON.stringify(exported.runOnSchedule),JSON.stringify(buildReplayEvidence(input.fallback)));
  assert.equal(JSON.stringify(exported.waitForFresh),JSON.stringify(buildReplayEvidence(input.wait)));
  exported.runOnSchedule.input!.jobs[0].runDuration = 1;
  assert.equal(exported.waitForFresh.input!.jobs[0].runDuration,12);
  assert.equal(buildComparisonEvidence(arrival).runOnSchedule.input!.jobs[0].runDuration,12);
});

test('comparison export reuses the exact evaluated runs selected by the visible view', () => {
  const evaluation = evaluatePolicyComparison(493);
  const view = selectComparisonRuns(evaluation);
  const bundle = evidenceFromComparison(evaluation);
  assert.equal(bundle.runOnSchedule.runs.find(run=>run.jobId===evaluation.input.reportId),view.fallback);
  assert.equal(bundle.waitForFresh.runs.find(run=>run.jobId===evaluation.input.reportId),view.wait);
  assert.equal(view.wait.completionMinute,495);
});

test('every encoded arrival changes only the report policy between the two branches', () => {
  for (let arrival=POLICY_ARRIVAL.min; arrival<=POLICY_ARRIVAL.max; arrival++) {
    const bundle = JSON.parse(JSON.stringify(buildComparisonEvidence(arrival))) as ReturnType<typeof buildComparisonEvidence>;
    const {input:fallback} = bundle.runOnSchedule;
    const {input:wait} = bundle.waitForFresh;
    assert(fallback && wait);
    const scheduledReport = fallback.jobs.find(job=>job.id==='report-w1')!;
    const waitingReport = wait.jobs.find(job=>job.id==='report-w1')!;
    assert.equal(scheduledReport.fallbackEnabled,true);
    assert.equal(scheduledReport.waitPolicy,undefined);
    assert.equal(waitingReport.fallbackEnabled,false);
    assert.deepEqual(waitingReport.waitPolicy,{key:'data',requiredWindow:1,deadline:495});
    for (const branch of [fallback,wait]) {
      const collector = branch.jobs.find(job=>job.id==='collector-w1')!;
      assert.equal(collector.scheduledStart+collector.runDuration,arrival);
    }
    delete waitingReport.waitPolicy;
    waitingReport.fallbackEnabled = true;
    assert.deepEqual(wait,fallback,'Other encoded inputs must be identical at minute '+arrival);
  }
});

test('summary only describes a late configured arrival or successful completion when supported', () => {
  const merged = comparePolicies(492);
  const summary = (arrival: number, wait = merged.wait) => comparePolicySummary(arrival,merged.cutoff,merged.fallback,wait);
  assert.match(summary(492),/finishes 6 minutes later/);
  const absent = { ...merged.wait, completionMinute:null, completionStatus:'DeadlineMissed' as const, missReason:'ArtifactNeverPublished' as const };
  assert.match(summary(492,absent),/No usable publication was observed/);
  assert.match(summary(496,absent),/configured collector arrival is after the 08:15 cutoff/);
  assert.equal(summary(492,{...merged.wait,completionStatus:'Failure'}),'Compare the outcomes below.');
});

test('comparison prose does not confuse expiry with using a prior window', () => {
  const view = comparePolicies(492);
  const summary = (staleReason: typeof view.fallback.reads[0]['staleReason']) =>
    comparePolicySummary(view.arrival,view.cutoff,{...view.fallback,
      reads:[{...view.fallback.reads[0],staleReason}]},view.wait);
  assert.match(summary('PriorWindow'), /uses the prior window/);
  assert.match(summary('ExpiredExact'), /uses the right window past its freshness limit/);
  assert.doesNotMatch(summary('ExpiredExact'), /prior window/);
  assert.match(summary(undefined), /uses stale data/);
});

test('the cutoff teaching example follows the first failing minute of the current policy', () => {
  const miss = POLICY_EXAMPLES.cutoffMiss;
  assert(miss !== null);
  const exact = comparePolicies(miss-1);
  assert.equal(exact.wait.completionMinute,exact.cutoff);
  assert.equal(comparePolicies(miss).wait.missReason,'CompletionWouldExceedCutoff');
  const oneLate = comparePolicies(miss);
  assert.equal(oneLate.earliestFinish,496);
  assert.match(comparePolicySummary(miss,oneLate.cutoff,oneLate.fallback,oneLate.wait,oneLate.earliestFinish),
    /Earliest possible finish: 08:16/);
  assert.equal(exact.earliestFinish,null);
  assert.equal(comparePolicies(496).earliestFinish,null);
  assert.equal(comparePolicies(POLICY_EXAMPLES.tradeoff).wait.inputFreshnessStatus,'Fresh');
});

const label = (n: number, text: string) => 'Audit ' + String(n).padStart(3, '0') + ': ' + text;
test('late scenario variants select the collector and report by role under reordered fixtures', () => {
  const baseline = comparePolicies(492);
  ch02.jobs.reverse();
  try {
    assert.deepEqual(comparePolicies(492),baseline);
    assert.equal(lateWithoutFallback().jobs.find(job=>job.id==='report-w1')?.fallbackEnabled,false);
    assert.equal(ch02.jobs.find(job=>job.id==='report-w1')?.fallbackEnabled,true);
  } finally {
    ch02.jobs.reverse();
  }
});

test('isolated policy branches cannot change sibling or future comparison fixtures', () => {
  const before = JSON.stringify(policyInputs(492));
  const params = policyInputs(492);
  params.fallback.preloadedArtifacts![0].windowIndex = 99;
  params.fallback.jobs[0].output!.key = 'edited';
  params.fallback.jobs[1].inputs[0].requiredWindow = 99;
  assert.equal(params.wait.preloadedArtifacts![0].windowIndex,0);
  assert.equal(params.wait.jobs[0].output!.key,'data');
  assert.equal(params.wait.jobs[1].inputs[0].requiredWindow,1);
  assert.equal(JSON.stringify(policyInputs(492)),before);
});
for (let minute = 484; minute <= 498; minute++) {
  test(label(minute - 483, 'counterfactual at 08:' + String(minute - 480).padStart(2, '0')), () => {
    // Independent oracle: fallback starts at 486; fresh wait starts no earlier
    // than 486 and can only finish two minutes later, by inclusive minute 495.
    const result = comparePolicies(minute);
    assert.equal(result.fallback.actualStart, 486);
    assert.equal(result.fallback.completionMinute, 488);
    assert.equal(result.fallback.inputFreshnessStatus, minute <= 486 ? 'Fresh' : 'Stale');
    assert.equal(result.fallback.reads[0].publishMinute, minute <= 486 ? minute : 460);
    if (minute <= 493) {
      assert.equal(result.wait.actualStart, Math.max(486, minute));
      assert.equal(result.wait.completionMinute, Math.max(486, minute) + 2);
      assert.equal(result.wait.inputFreshnessStatus, 'Fresh');
    } else {
      assert.equal(result.wait.actualStart, null);
      assert.equal(result.wait.completionMinute, null);
      assert.equal(result.wait.missReason, minute <= 495 ? 'CompletionWouldExceedCutoff' : 'ArtifactNeverPublished');
    }
  });
}
test(label(16, 'reject arrival before the range'), () => assert.throws(() => comparePolicies(483), RangeError));
test(label(17, 'reject arrival after the range'), () => assert.throws(() => comparePolicies(499), RangeError));
test(label(18, 'reject fractional arrival'), () => assert.throws(() => comparePolicies(492.5), RangeError));
test(label(19, 'evidence contains a versioned, executable input'), () => {
  const output = simulate(ch02);
  const bundle = buildEvidence(output, ch02);
  assert.equal(bundle.schemaVersion, 1);
  assert.deepEqual(simulate(bundle.input!), output);
});
test(label(20, 'evidence snapshots its replay input'), () => {
  const input = structuredClone(ch02);
  const bundle = buildEvidence(simulate(input), input);
  input.jobs[0].runDuration += 1;
  assert.notEqual(bundle.input!.jobs[0].runDuration, input.jobs[0].runDuration);
});
test(label(21, 'contract remains compatible with output-only callers'), () => {
  const output = simulate(ch02);
  const bundle = buildEvidence(output);
  assert(Object.hasOwn(bundle, 'eventLog'));
  assert(!Object.hasOwn(bundle, 'input'));
});
test(label(22, 'evidence bytes do not depend on replay time'), async () => {
  const once = JSON.stringify(buildEvidence(simulate(ch02), ch02));
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(JSON.stringify(buildEvidence(simulate(ch02), ch02)), once);
});
test(label(23, 'heap preserves lexical ties in reverse input order'), () => {
  const q = new EventQueue();
  for (const id of ['z', 'q', 'b', 'a']) q.push(makeEntry(100, 2, id, 'Admission', null, id));
  assert.deepEqual(Array.from({ length: 4 }, () => q.pop()?.entityId), ['a', 'b', 'q', 'z']);
});
test(label(24, 'heap matches an independently sorted oracle with interleaved insertions'), () => {
  const q = new EventQueue();
  const oracle: ReturnType<typeof makeEntry>[] = [];
  for (let i = 0; i < 1000; i++) {
    const id = 'job-' + i;
    const event = makeEntry((i * 71) % 940, i % 2 ? 1 : 4, id, i % 2 ? 'Completion' : 'DeadlineMiss', null, id);
    q.push(event);
    oracle.push(event);
    if (i % 3 === 2) {
      oracle.sort((a, b) => a.sortKey < b.sortKey ? -1 : 1);
      assert.equal(q.pop()?.sortKey, oracle.shift()?.sortKey);
    }
  }
  oracle.sort((a, b) => a.sortKey < b.sortKey ? -1 : 1);
  assert.deepEqual(oracle.map(() => q.pop()?.sortKey), oracle.map(e => e.sortKey));
  assert.equal(q.pop(), undefined);
});
test(label(25, 'heap rejects a reused event key'), () => {
  const q = new EventQueue();
  const entry = makeEntry(400, 1, 'id', 'Completion', null, 'id');
  q.push(entry);
  q.pop();
  assert.throws(() => q.push(entry), /duplicate event key/);
});
