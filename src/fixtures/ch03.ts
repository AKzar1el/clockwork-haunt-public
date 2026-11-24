import type { ScenarioConfig } from '../engine/types.ts';

const BASE_REPORT = {
  id: 'report-w1',
  scheduledStart: 486,
  runDuration: 2,
  inputs: [{ key: 'data', requiredWindow: 1 }],
  fallbackEnabled: false,
  waitPolicy: { key: 'data', requiredWindow: 1, deadline: 495 },
  scheduledPublishMinutes: {} as Record<string, number>,
};

/** CH-03a: Collector publishes at 492; report admits at 492, finishes 494. */
export const ch03a: ScenarioConfig = {
  scenarioId: 'CH-03a',
  maxArtifactAge: 60,
  jobs: [
    {
      id: 'collector-w1',
      scheduledStart: 480,
      runDuration: 12,
      inputs: [],
      output: { key: 'data', windowIndex: 1 },
      scheduledPublishMinutes: { 'data:1': 492 },
      deduplicationEnabled: true,
    },
    { ...BASE_REPORT, scheduledPublishMinutes: { 'data:1': 492 } },
  ],
};

/** CH-03b: No collector — artifact never published; deadline miss at 495. */
export const ch03b: ScenarioConfig = {
  scenarioId: 'CH-03b',
  maxArtifactAge: 60,
  jobs: [
    { ...BASE_REPORT, scheduledPublishMinutes: {} },
  ],
};

/** CH-03c: Collector publishes at 495; effectiveStart 495, 495+2=497 > 495 → miss. */
export const ch03c: ScenarioConfig = {
  scenarioId: 'CH-03c',
  maxArtifactAge: 60,
  jobs: [
    {
      id: 'collector-w1',
      scheduledStart: 480,
      runDuration: 15,
      inputs: [],
      output: { key: 'data', windowIndex: 1 },
      scheduledPublishMinutes: { 'data:1': 495 },
      deduplicationEnabled: true,
    },
    { ...BASE_REPORT, scheduledPublishMinutes: { 'data:1': 495 } },
  ],
};

/** Regression: artifact is Fresh at scheduledStart → admit immediately without waiting. */
export const ch03ImmediateAdmit: ScenarioConfig = {
  scenarioId: 'CH-03-immediate',
  maxArtifactAge: 60,
  preloadedArtifacts: [
    { key: 'data', windowIndex: 1, publishMinute: 480, attemptId: 'preload-w1', producerValid: true },
  ],
  jobs: [
    { ...BASE_REPORT, scheduledPublishMinutes: {} },
  ],
};

/** Regression: W0 artifact (wrong window) arrives at 492; job stays Blocked; deadline miss at 495. */
export const ch03NonFreshArrival: ScenarioConfig = {
  scenarioId: 'CH-03-non-fresh',
  maxArtifactAge: 60,
  jobs: [
    {
      // Publishes W0, not W1 — wrong window; job waiting for W1 stays Blocked.
      id: 'collector-w0',
      scheduledStart: 480,
      runDuration: 12,
      inputs: [],
      output: { key: 'data', windowIndex: 0 }, // wrong window
      deduplicationEnabled: true,
    },
    { ...BASE_REPORT, scheduledPublishMinutes: {} },
  ],
};
