import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { simulate } from '../src/engine/simulator.ts';
import { replayModel } from '../src/export/evidence.ts';

const args = process.argv.slice(2);
const usage = 'Usage: node --experimental-strip-types scripts/benchmark.mjs [--fanout | --supplied-index] [--expect SHA256]';
if (args.length === 1 && args[0] === '--help') {
  console.log(usage);
  console.log('Default: 3,000 mixed jobs. --fanout: 1,200 waiters. --supplied-index: 25,001 supplied artifacts.');
  console.log('Fixed synthetic fixtures for local comparison, not production latency estimates.');
  console.log('--expect checks a previous outputSha256 for the same workload and replay model before timing.');
  process.exit(0);
}
const modes = ['--fanout','--supplied-index'];
const mode = modes.includes(args[0]) ? args.shift() : undefined;
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--expect' || !/^[0-9a-f]{64}$/.test(args[1]))) {
  console.error(usage);
  process.exit(2);
}
const fanout = mode === '--fanout';
const suppliedIndex = mode === '--supplied-index';
const jobCount = suppliedIndex ? 2 : fanout ? 1200 : 3000;
const sampleCount = 5;
const supplyTarget = {key:'target',requiredWindow:1};
const scenario = suppliedIndex ? {
  scenarioId:'supplied-index-focus',
  maxArtifactAge:60,
  preloadedArtifacts:[
    ...Array.from({length:25000},(_,i)=>({key:'ordinary-'+i,windowIndex:1,publishMinute:10,
      attemptId:'old-'+i,producerValid:true})),
    {key:'target',windowIndex:1,publishMinute:25,attemptId:'target-25',producerValid:true},
  ],
  jobs:[
    {id:'ordinary',scheduledStart:20,runDuration:1,inputs:[{key:'ordinary-24999',requiredWindow:1}]},
    {id:'waiting',scheduledStart:20,runDuration:1,inputs:[supplyTarget],waitPolicy:{...supplyTarget,deadline:30}},
  ],
} : fanout ? {
  scenarioId: 'supplied-wait-fanout-v1',
  maxArtifactAge: 0,
  preloadedArtifacts: Array.from({ length: 120 }, (_, index) => ({
    key: 'data', windowIndex: 1, publishMinute: 120 + index,
    attemptId: 'supply-' + index, producerValid: true,
  })),
  jobs: Array.from({ length: jobCount }, (_, index) => ({
    id: 'report-' + index, scheduledStart: 100, runDuration: 2,
    inputs: [{ key: 'data', requiredWindow: 1 }],
    waitPolicy: { key: 'data', requiredWindow: 1, deadline: 250 },
  })),
} : {
  scenarioId: 'local-benchmark-v1',
  maxArtifactAge: 60,
  preloadedArtifacts: [{ key: 'data', windowIndex: 0, publishMinute: 460, attemptId: 'seed', producerValid: true }],
  jobs: [
    { id: 'collector', scheduledStart: 480, runDuration: 12, inputs: [], output: { key: 'data', windowIndex: 1 } },
    ...Array.from({ length: jobCount - 1 }, (_, index) => {
      const input = { key: 'data', requiredWindow: 1 };
      return {
        id: 'report-' + index,
        scheduledStart: 486,
        runDuration: 2,
        inputs: [input],
        ...(index % 2 === 0 ? { fallbackEnabled: true } : { waitPolicy: { ...input, deadline: 495 } }),
      };
    }),
  ],
};

const digest = result => createHash('sha256').update(JSON.stringify(result)).digest('hex');
const warm = simulate(scenario);
assert.equal(warm.runs.length, jobCount);
const expectedWaiters = suppliedIndex ? 1 : fanout ? jobCount : 1499;
assert.equal(warm.runs.filter(run => run.waitOutcome === 'ArtifactArrived').length,expectedWaiters);
assert.equal(warm.runs.filter(run => run.inputFreshnessStatus === 'Stale').length, suppliedIndex || fanout ? 0 : 1500);
assert(warm.runs.every(run => run.completionStatus === 'Success'));
const observed = warm.runs.filter(run=>run.policyArtifact);
const expectedPublisher = suppliedIndex ? 'target-25' : fanout ? 'supply-0' : 'collector';
const expectedMinute = suppliedIndex ? 25 : fanout ? 120 : 492;
assert.equal(observed.length,expectedWaiters);
assert(observed.every(run=>{
  const gate = run.policyArtifact;
  return gate.key===(suppliedIndex?'target':'data') && gate.windowIndex===1 && gate.producerAttemptId===expectedPublisher &&
    gate.publishMinute===expectedMinute && gate.decisionMinute===expectedMinute && gate.ageAtDecision===0;
}));
if (fanout) {
  assert.equal(warm.eventLog.filter(event => event.kind === 'WaitEnd').length, jobCount);
  assert(warm.runs.every(run => run.actualStart === 120 && run.completionMinute === 122 &&
    run.reads[0]?.producerAttemptId === 'supply-0'));
}
if (suppliedIndex) {
  assert.deepEqual(warm.runs.map(run=>[run.actualStart,run.reads[0]?.producerAttemptId]),[
    [20,'old-24999'],[25,'target-25'],
  ]);
}
const expected = digest(warm);
if (args[0] === '--expect' && args[1] !== expected) {
  console.error('Benchmark output changed for ' + scenario.scenarioId + ' (' + replayModel + ').');
  console.error('Expected: ' + args[1] + '\nObserved: ' + expected);
  process.exit(1);
}
const samples = [];
for (let i = 0; i < sampleCount; i++) {
  const start = performance.now();
  const result = simulate(scenario);
  samples.push(performance.now() - start);
  assert.equal(digest(result), expected, 'Measured runs must produce identical output');
}
const median = [...samples].sort((a, b) => a - b)[Math.floor(sampleCount / 2)];
console.log(JSON.stringify({
  workload: scenario.scenarioId, jobs: jobCount, suppliedArtifacts: scenario.preloadedArtifacts.length, node: process.version,
  platform: process.platform, arch: process.arch, replayModel, warmupRuns: 1,
  sampleMilliseconds: samples.map(sample => Number(sample.toFixed(2))),
  medianMilliseconds: Number(median.toFixed(2)), outputSha256: expected,
}, null, 2));
