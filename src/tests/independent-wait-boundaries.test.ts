import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JobDefinition, ScenarioConfig } from '../engine/types.ts';
import { simulate } from '../engine/simulator.ts';

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

test('a wait policy does not admit a run whose ordinary input list is empty', () => {
  const run = result([{ ...report, inputs: [] }]).runs[0];
  assert.equal(run.actualStart, null);
  assert.equal(run.missReason, 'ArtifactNeverPublished');
});

test('zero or fractional run durations are invalid', () => {
  for (const duration of [0, -1, 1.5]) {
    assert.throws(() => result([collector(duration)]), /runDuration must be a positive integer/);
  }
});
