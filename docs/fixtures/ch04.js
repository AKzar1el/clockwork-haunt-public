                                                         

const JOBS = [
  {
    id: 'attempt-1',
    scheduledStart: 486,
    runDuration: 1,
    inputs: []                                                  ,
    output: { key: 'result', windowIndex: 1 },
  },
  {
    id: 'attempt-2',
    scheduledStart: 486,
    runDuration: 1,
    inputs: []                                                  ,
    output: { key: 'result', windowIndex: 1 },
  },
];

/** CH-04 with deduplication enabled: second commit suppressed. */
export const ch04Enabled                 = {
  scenarioId: 'CH-04-enabled',
  maxArtifactAge: 60,
  jobs: JOBS.map((j) => ({ ...j, deduplicationEnabled: true })),
};

/** CH-04 with deduplication disabled: both commits accepted. */
export const ch04Disabled                 = {
  scenarioId: 'CH-04-disabled',
  maxArtifactAge: 60,
  jobs: JOBS.map((j) => ({ ...j, deduplicationEnabled: false })),
};
