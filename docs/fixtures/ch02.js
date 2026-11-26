                                                         

/** CH-02: Stale fallback, no retroactive relabelling.
 *  W0 preloaded at minute 460.
 *  Collector-w1 starts 08:00, finishes 08:12 (minute 492).
 *  Report starts 08:06 (minute 486) — W1 not yet published.
 *  Fallback enabled → reads W0 (Stale). After 492 publish, read stays Stale.
 */
export const ch02                 = {
  scenarioId: 'CH-02',
  maxArtifactAge: 60,
  preloadedArtifacts: [
    { key: 'data', windowIndex: 0, publishMinute: 460, attemptId: 'preload-w0', producerValid: true },
  ],
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
    {
      id: 'report-w1',
      scheduledStart: 486,
      runDuration: 2,
      inputs: [{ key: 'data', requiredWindow: 1 }],
      fallbackEnabled: true,
      scheduledPublishMinutes: { 'data:1': 492 },
    },
  ],
};

export function lateCollectorJobs(scenario                ) {
  const collector = scenario.jobs.find(job=>job.id==='collector-w1');
  const report = scenario.jobs.find(job=>job.id==='report-w1');
  if (!collector?.output || !report || report.inputs.length !== 1 ||
      report.inputs[0].key !== collector.output.key || report.inputs[0].requiredWindow !== collector.output.windowIndex) {
    throw new Error('Late collector fixture must publish the report\'s one required input.');
  }
  return {collector,report,target:report.inputs[0]};
}

/** The same late collector, but the report does not use the prior window. */
export function lateWithoutFallback()                 {
  const scenario = structuredClone(ch02);
  scenario.scenarioId = 'CH-02-no-fallback';
  lateCollectorJobs(scenario).report.fallbackEnabled = false;
  return scenario;
}
