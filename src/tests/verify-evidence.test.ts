import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { readEvidenceFile, verifyEvidence } from '../../scripts/verify-evidence.mjs';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { buildComparisonEvidence, buildEvidence, buildReplayEvidence, replayModel } from '../export/evidence.ts';
import { simulate } from '../engine/simulator.ts';
import { ch02 } from '../fixtures/ch02.ts';
import { ch04Enabled } from '../fixtures/ch04.ts';

test('preset and comparison exports can be reconstructed and altered outputs rejected', () => {
  const preset = JSON.parse(JSON.stringify(buildReplayEvidence(ch02)));
  assert.equal(verifyEvidence(preset),'CH-02');
  preset.runs[1].completionMinute += 1;
  assert.throws(()=>verifyEvidence(preset),/does not match.*Mismatched sections: runs\. First mismatched run row: 2\./);
  const comparison = JSON.parse(JSON.stringify(buildComparisonEvidence(494)));
  assert.equal(verifyEvidence(comparison),'policy comparison');
  comparison.waitForFresh.input.jobs[0].runDuration -= 1;
  assert.throws(()=>verifyEvidence(comparison), {
    message:'The recorded evidence does not match a reconstruction from its inputs. Mismatched sections: waitForFresh. Recorded replay inputs differ in waitForFresh.',
  });
  comparison.runOnSchedule.input.scenarioId = 'edited-private-value';
  comparison.waitForFresh.runs[1].scheduledStart += 1;
  assert.throws(()=>verifyEvidence(comparison), {
    message:'The recorded evidence does not match a reconstruction from its inputs. Mismatched sections: runOnSchedule, waitForFresh. Recorded replay inputs differ in runOnSchedule. First mismatched run row in waitForFresh: 2. Recorded replay inputs differ in waitForFresh.',
  });
  assert.throws(()=>verifyEvidence({...comparison,schemaVersion:2}),/version 1/);
  assert.throws(()=>verifyEvidence({...comparison,replayModel:'future-model'}),/replay model is missing or unsupported/);
});

test('unrecognized evidence envelope fields are not echoed in verifier diagnostics', () => {
  const preset = JSON.parse(JSON.stringify(buildReplayEvidence(ch02)));
  preset['unrecognized diagnostic bait'] = true;
  assert.throws(() => verifyEvidence(preset), {
    message: 'The recorded evidence does not match a reconstruction from its inputs. Check the evidence envelope.',
  });
});

test('a changed terminal effect identifies the first differing event row without echoing its value', () => {
  const preset = JSON.parse(JSON.stringify(buildReplayEvidence(ch04Enabled)));
  const index = preset.eventLog.findIndex(event=>event.completion?.output?.kind==='Suppressed');
  assert(index>=0 && verifyEvidence(preset)==='CH-04-enabled');
  preset.eventLog[index].completion.output.acceptedEffectId = 'edited-output';
  assert.throws(()=>verifyEvidence(preset), {
    message:'The recorded evidence does not match a reconstruction from its inputs. Mismatched sections: eventLog. First mismatched event row: ' + (index+1) + '.',
  });
});

test('a comparison event mismatch names its branch and local event row', () => {
  const comparison: ReturnType<typeof buildComparisonEvidence> = JSON.parse(JSON.stringify(buildComparisonEvidence(492)));
  const index = comparison.waitForFresh.eventLog.length - 1;
  comparison.waitForFresh.eventLog.splice(index,1);
  assert.throws(()=>verifyEvidence(comparison), {
    message:'The recorded evidence does not match a reconstruction from its inputs. Mismatched sections: waitForFresh. First mismatched event row in waitForFresh: ' + (index+1) + '.',
  });
});

test('slot and incident mismatches identify their first rows without exposing evidence data', () => {
  const preset = JSON.parse(JSON.stringify(buildReplayEvidence(ch04Enabled)));
  preset.slots[0].effectCount += 1;
  assert.throws(()=>verifyEvidence(preset),{
    message:'The recorded evidence does not match a reconstruction from its inputs. Mismatched sections: slots. First mismatched output slot row: 1.',
  });
  const comparison = JSON.parse(JSON.stringify(buildComparisonEvidence(492)));
  comparison.runOnSchedule.trace[0].reportId = 'edited-identifier';
  assert.throws(()=>verifyEvidence(comparison),{
    message:'The recorded evidence does not match a reconstruction from its inputs. Mismatched sections: runOnSchedule. First mismatched incident trace row in runOnSchedule: 1.',
  });
});

test('offline verifier has stable caps before reconstructing large scenarios', () => {
  const base = buildReplayEvidence(ch02);
  assert.throws(()=>verifyEvidence({...base,input:{...base.input,jobs:Array(10001).fill(null)}}),/10,000 jobs/);
  assert.throws(()=>verifyEvidence({...base,input:{...base.input,preloadedArtifacts:Array(30001).fill(null)}}),/30,000 supplied artifacts/);
  const jobs = Array.from({length:101},()=>({inputs:Array(1000).fill(null)}));
  assert.throws(()=>verifyEvidence({...base,input:{...base.input,jobs}}),/100,000 configured reads/);
  assert.equal(verifyEvidence(JSON.parse(JSON.stringify(base))),'CH-02');
});

test('out-of-range JSON numbers are rejected directly instead of becoming null silently', () => {
  const seed = JSON.stringify(buildReplayEvidence(ch02));
  const exaggerated = JSON.parse(seed.replace('"maxArtifactAge":60','"maxArtifactAge":1e400'));
  assert.equal(exaggerated.input.maxArtifactAge,Infinity);
  assert.throws(()=>verifyEvidence(exaggerated),{message:'Evidence contains a number outside the supported finite range.'});
  const invalidObservation = JSON.parse(seed);
  invalidObservation.runs[0].scheduledStart = -Infinity;
  assert.throws(()=>verifyEvidence(invalidObservation),/outside the supported finite range/);
  assert.equal(verifyEvidence(JSON.parse(seed)),'CH-02');
});

test('the finite JSON fast path preserves existing wire semantics for signed zero', () => {
  const seed = JSON.stringify(buildReplayEvidence({...ch02,maxArtifactAge:0}));
  assert.equal(verifyEvidence(JSON.parse(seed)),'CH-02');
  const alternate = JSON.parse(seed.replace('"maxArtifactAge":0','"maxArtifactAge":-0'));
  assert(Object.is(alternate.input.maxArtifactAge,-0));
  assert.throws(()=>verifyEvidence(alternate),/does not match.*Check the evidence envelope/);
});

test('the verifier CLI separates help, usage errors and evidence errors', () => {
  const run = (...args: string[])=>spawnSync(process.execPath,
    ['--experimental-strip-types','scripts/verify-evidence.mjs',...args],{encoding:'utf8',timeout:30000,windowsHide:true});
  const help = run('--help');
  assert.ifError(help.error);
  assert.equal(help.status,0);
  assert.match(help.stdout,/^Usage:/);
  assert(help.stdout.includes(replayModel));
  assert.match(help.stdout,/not authorship/);
  const usage = run();
  assert.ifError(usage.error);
  assert.equal(usage.status,2);
  assert.match(usage.stderr,/^Usage:/);
  const missing = run('test-results/missing-cli-evidence-directory/no-file.json');
  assert.ifError(missing.error);
  assert.equal(missing.status,1);
  assert.match(missing.stderr,/Evidence file not found/);
});

test('a nested JSON container is rejected before clone or serialization errors', () => {
  const base = buildReplayEvidence(ch02);
  let nested: unknown = 'leaf';
  for (let index=0; index<40; index++) nested = index%2 ? [nested] : {nested};
  assert.throws(()=>verifyEvidence({...base,input:{...base.input,fixtureNote:nested}}),/offline limit of 32 containers/);
  assert.equal(verifyEvidence(JSON.parse(JSON.stringify(base))),'CH-02');
});

test('offline container depth admits the documented boundary inclusively', () => {
  const nest = (levels: number) => {
    let value: unknown = 'leaf';
    for (let index=0; index<levels; index++) value = index%2 ? [value] : {child:value};
    return value;
  };
  // The envelope and scenario are the first two containers.
  const input = {...ch02,fixtureNote:nest(30)};
  const atLimit = JSON.parse(JSON.stringify(buildReplayEvidence(input)));
  assert.equal(verifyEvidence(atLimit),'CH-02');
  const beyondLimit = {...atLimit,input:{...atLimit.input,fixtureNote:nest(31)}};
  assert.throws(()=>verifyEvidence(beyondLimit),/offline limit of 32 containers/);
});

test('unsupported kinds and malformed envelopes are rejected explicitly', () => {
  const base = buildReplayEvidence(ch02);
  assert.throws(()=>verifyEvidence({...base,kind:'unrecognized'}),/Unsupported evidence kind/);
  assert.throws(()=>verifyEvidence({...base,input:[]}),/input must be a JSON object/);
  assert.throws(()=>verifyEvidence({...base,eventLog:null}),/missing a required results array/);
  assert.throws(()=>verifyEvidence({...buildComparisonEvidence(492),waitForFresh:null}),/both recorded policy results/);
});

test('invalid scenario data is distinguished from a mismatch in valid recorded outputs', () => {
  const valid = buildReplayEvidence(ch02);
  const input = structuredClone(valid.input!);
  input.jobs[0].runDuration = 0;
  assert.throws(()=>verifyEvidence({...valid,input}),/Invalid replay input: Job .*runDuration must be a positive integer/);
});

test('comparison verifies input bounds and requires matching evidence versions in both branches', () => {
  const sample = buildComparisonEvidence(492);
  for (const arrival of [null, '492', 492.5, 499]) {
    assert.throws(()=>verifyEvidence({...sample,arrival}),/Invalid policy comparison input: arrival/);
  }
  assert.throws(()=>verifyEvidence({...sample,waitForFresh:{...sample.waitForFresh,replayModel:'older'}}),
    /different evidence version: waitForFresh/);
  assert.throws(()=>verifyEvidence({...sample,runOnSchedule:{...sample.runOnSchedule,schemaVersion:2}}),
    /different evidence version: runOnSchedule/);
  assert.equal(verifyEvidence(JSON.parse(JSON.stringify(sample))),'policy comparison');
});

test('verification checks consistency rather than provenance of a named scenario', () => {
  const changed = structuredClone(ch02);
  changed.jobs[1].runDuration += 1;
  const baseline = JSON.parse(JSON.stringify(buildReplayEvidence(ch02)));
  const regenerated = JSON.parse(JSON.stringify(buildReplayEvidence(changed)));
  assert.equal(regenerated.scenarioId, baseline.scenarioId);
  assert.notDeepEqual(regenerated.runs, baseline.runs);
  assert.equal(verifyEvidence(regenerated), 'CH-02');
});

test('the current verifier requires exact wait-gate records and does not reinterpret earlier models', () => {
  const bundle = JSON.parse(JSON.stringify(buildComparisonEvidence(494))) as ReturnType<typeof buildComparisonEvidence>;
  const report = bundle.waitForFresh.runs.find(run=>run.jobId==='report-w1')!;
  assert.equal(report.policyArtifact?.producerAttemptId,'collector-w1');
  assert.equal(verifyEvidence(bundle),'policy comparison');
  report.policyArtifact = {...report.policyArtifact!,producerAttemptId:'different-attempt'};
  assert.throws(()=>verifyEvidence(bundle), {
    message:'The recorded evidence does not match a reconstruction from its inputs. Mismatched sections: waitForFresh. First mismatched run row in waitForFresh: 2.',
  });
  assert.throws(()=>verifyEvidence({...bundle,replayModel:'clockwork-minute-v5'}),
    /This verifier supports clockwork-minute-v6/);
});

test('a comparison cannot substitute a different scenario even if that branch replays on its own', () => {
  const comparison = buildComparisonEvidence(492);
  const changed = structuredClone(comparison.waitForFresh.input!);
  changed.jobs[0].runDuration += 1;
  const branch = JSON.parse(JSON.stringify(buildReplayEvidence(changed)));
  assert.equal(verifyEvidence(branch), changed.scenarioId);
  assert.throws(() => verifyEvidence({...comparison,waitForFresh:branch}),
    /does not match.*Mismatched sections: waitForFresh\./);
});

test('evidence loader bounds local files and gives clean syntax diagnostics', async () => {
  const root = resolve('test-results');
  await mkdir(root,{recursive:true});
  const scratch = await mkdtemp(join(root,'verify-evidence-'));
  try {
    const bad = join(scratch,'bad.json');
    await assert.rejects(readEvidenceFile(bad), {message:'Evidence file not found. Check the file path.'});
    await writeFile(bad,'invalid partial JSON');
    await assert.rejects(readEvidenceFile(bad),{message:'Evidence file is not valid JSON.'});
    const unambiguous = JSON.stringify(buildReplayEvidence(ch02));
    const conflicting = unambiguous.replace('"scenarioId":"CH-02"',
      '"scenario\\u0049d":"other-replay","scenarioId":"CH-02"');
    assert.notEqual(conflicting,unambiguous);
    const duplicate = join(scratch,'ambiguous.json');
    await writeFile(duplicate,conflicting);
    await assert.rejects(readEvidenceFile(duplicate),{message:'Evidence JSON repeats a member name in the same object.'});
    const ambiguity = spawnSync(process.execPath,['--experimental-strip-types','scripts/verify-evidence.mjs',duplicate],
      {encoding:'utf8',timeout:30000,windowsHide:true});
    assert.ifError(ambiguity.error);
    assert.equal(ambiguity.status,1,ambiguity.stdout);
    assert.equal(ambiguity.stderr.trim(),'Evidence JSON repeats a member name in the same object.');
    await writeFile(duplicate,'{"windows":[{"id":1,"id":2}]}');
    await assert.rejects(readEvidenceFile(duplicate),/repeats a member name/);
    const repeated = '{"windows":[{"id":"a"},{"id":"b"}],"message":"quote: \\"id\\", braces: { }"}';
    await writeFile(duplicate,repeated);
    assert.deepEqual(await readEvidenceFile(duplicate),JSON.parse(repeated));
    const invalidEncoding = join(scratch,'encoding.json');
    await writeFile(invalidEncoding,Buffer.from([0x22,0xc3,0x28,0x22]));
    await assert.rejects(readEvidenceFile(invalidEncoding),{message:'Evidence file is not valid UTF-8.'});
    await writeFile(invalidEncoding,'\uFEFF{"label":"Šeregi"}');
    assert.deepEqual(await readEvidenceFile(invalidEncoding),{label:'Šeregi'});
    const tooLarge = join(scratch,'large.json');
    const file = await open(tooLarge,'w');
    try { await file.truncate(8*1024*1024+1); } finally { await file.close(); }
    await assert.rejects(readEvidenceFile(tooLarge),/at or below 8 MiB/);
    await assert.rejects(readEvidenceFile(scratch),/regular local evidence file/);
    const named = join(scratch,'line break scenario.json');
    await writeFile(named,JSON.stringify(buildReplayEvidence({...ch02,scenarioId:'Night\nShift'})));
    const checked = spawnSync(process.execPath,['--experimental-strip-types','scripts/verify-evidence.mjs',named],{encoding:'utf8',timeout:30000,windowsHide:true});
    assert.ifError(checked.error);
    assert.equal(checked.status,0,checked.stderr);
    assert.equal(checked.stdout.trim(),'Evidence matches the replay: Night\\u000aShift');
    const longName = 'x'.repeat(239);
    const clock = String.fromCodePoint(0x1f556);
    await writeFile(named,JSON.stringify(buildReplayEvidence({...ch02,scenarioId:longName+clock+'tail'})));
    const shortened = spawnSync(process.execPath,['--experimental-strip-types','scripts/verify-evidence.mjs',named],
      {encoding:'utf8',timeout:30000,windowsHide:true});
    assert.ifError(shortened.error);
    assert.equal(shortened.status,0,shortened.stderr);
    assert.equal(shortened.stdout.trim(),'Evidence matches the replay: '+longName+String.fromCodePoint(0x2026));
    const disagreement = buildComparisonEvidence(492);
    for (const branch of [disagreement.runOnSchedule,disagreement.waitForFresh]) {
      branch.runs.splice(0);
      branch.slots.splice(0);
      branch.trace.splice(0);
      branch.eventLog.splice(0);
    }
    await writeFile(named,JSON.stringify(disagreement));
    const mismatch = spawnSync(process.execPath,['--experimental-strip-types','scripts/verify-evidence.mjs',named],
      {encoding:'utf8',timeout:30000,windowsHide:true});
    assert.ifError(mismatch.error);
    assert.equal(mismatch.status,1);
    assert.match(mismatch.stderr,/First mismatched event row in waitForFresh: 1\./);
    assert.equal((mismatch.stderr.match(/First mismatched/g)??[]).length,8);
    assert(mismatch.stderr.trim().length<800);
    const atLimit = join(scratch,'at-limit.json');
    const value = JSON.stringify({label:'\u0160eregi'});
    const source = value + ' '.repeat(8*1024*1024-Buffer.byteLength(value));
    await writeFile(atLimit,source);
    assert.deepEqual(await readEvidenceFile(atLimit),{label:'\u0160eregi'});
  } finally {
    if (resolve(scratch).startsWith(root+sep)) await rm(scratch,{recursive:true,force:true});
  }
});

test('an older output-only envelope is reported as non-replayable, not divergent', () => {
  const envelope = buildReplayEvidence(ch02);
  const older = {scenarioId:envelope.scenarioId,runs:envelope.runs,slots:envelope.slots,
    trace:envelope.trace,eventLog:envelope.eventLog};
  assert.throws(()=>verifyEvidence(older),/older evidence format contains no replay inputs/);
  assert.throws(()=>verifyEvidence({scenarioId:older.scenarioId}),/Expected a version 1/);
  assert.throws(()=>verifyEvidence(buildEvidence(simulate(ch02))),/no input to replay.*Export a full replay JSON/);
  assert.throws(()=>verifyEvidence({...envelope,replayModel:'clockwork-minute-v4'}),(error: Error)=>
    error.message.includes('This verifier supports '+replayModel) && !error.message.includes('v4'));
});
