import { simulate } from '../engine/simulator.js';
import { publishHintKey } from '../engine/classifier.js';
import { ch02, lateCollectorJobs } from './ch02.js';

export const POLICY_ARRIVAL = Object.freeze({ min: 484, max: 498, initial: 492 });
const policyCutoff = 495;

export function isPolicyArrival(value        ) {
  return Number.isInteger(value) && value >= POLICY_ARRIVAL.min && value <= POLICY_ARRIVAL.max;
}

const {report:nominalReport} = lateCollectorJobs(ch02);
const firstCutoffMiss = policyCutoff - nominalReport.runDuration + 1;
export const POLICY_EXAMPLES = Object.freeze({
  tradeoff: POLICY_ARRIVAL.initial,
  cutoffMiss: isPolicyArrival(firstCutoffMiss) && firstCutoffMiss >= nominalReport.scheduledStart ? firstCutoffMiss : null,
});

export function policyInputs(arrival        ) {
  if (!isPolicyArrival(arrival)) {
    throw new RangeError(`Collector arrival must be a whole minute from ${POLICY_ARRIVAL.min} to ${POLICY_ARRIVAL.max}.`);
  }
  const cutoff = policyCutoff;
  const fallback = structuredClone(ch02);
  fallback.scenarioId = 'policy-comparison';
  const {collector,report,target} = lateCollectorJobs(fallback);
  // The counterfactual owns both report policies; the preset supplies shared facts.
  report.fallbackEnabled = true;
  delete report.waitPolicy;
  const hint = publishHintKey(target.key,target.requiredWindow);
  collector.runDuration = arrival - collector.scheduledStart;
  collector.scheduledPublishMinutes = { ...collector.scheduledPublishMinutes, [hint]: arrival };
  report.scheduledPublishMinutes = { ...report.scheduledPublishMinutes, [hint]: arrival };
  const wait = structuredClone(fallback);
  const waitReport = lateCollectorJobs(wait).report;
  waitReport.fallbackEnabled = false;
  waitReport.waitPolicy = { ...target, deadline: cutoff };
  return { cutoff, fallback, wait, reportId: report.id };
}

export function evaluatePolicyComparison(arrival        ) {
  const input = policyInputs(arrival);
  return { arrival, input, onSchedule:simulate(input.fallback), waiting:simulate(input.wait) };
}

export function selectComparisonRuns(comparison                                             ) {
  const { arrival, input, onSchedule, waiting } = comparison;
  const timing = waiting.trace.find(entry=>entry.reportId===input.reportId &&
    entry.kind==='DeadlineMiss' && entry.detail.missReason==='CompletionWouldExceedCutoff');
  return { arrival, cutoff:input.cutoff,
    earliestFinish:typeof timing?.detail.earliestFinish==='number' ? timing.detail.earliestFinish : null,
    fallback:onSchedule.runs.find(run=>run.jobId===input.reportId) ,
    wait:waiting.runs.find(run=>run.jobId===input.reportId)  };
}

export function comparePolicies(arrival        ) {
  return selectComparisonRuns(evaluatePolicyComparison(arrival));
}
