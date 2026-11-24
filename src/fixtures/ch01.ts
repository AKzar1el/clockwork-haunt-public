import type { ScenarioConfig } from '../engine/types.ts';

/** CH-01: Fresh artifact, immutable read evidence.
 *  Collector starts 08:00, finishes 08:04 (minute 484).
 *  Report starts 08:06 (minute 486), reads Fresh artifact aged 2 min.
 */
export const ch01: ScenarioConfig = {
  scenarioId: 'CH-01',
  maxArtifactAge: 60,
  jobs: [
    {
      id: 'collector-w1',
      scheduledStart: 480,
      runDuration: 4,
      inputs: [],
      output: { key: 'data', windowIndex: 1 },
      deduplicationEnabled: true,
    },
    {
      id: 'report-w1',
      scheduledStart: 486,
      runDuration: 2,
      inputs: [{ key: 'data', requiredWindow: 1 }],
      fallbackEnabled: false,
    },
  ],
};
