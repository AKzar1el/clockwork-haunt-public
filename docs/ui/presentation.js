                                                                                                                              

export function scopedReplayUrl(current        )      {
  const url = new URL(current);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url;
}

export function formatReplayMinute(minute               )         {
  if (minute === null || !Number.isSafeInteger(minute) || minute < 0) return '—';
  const day = Math.floor(minute / 1440);
  const withinDay = minute % 1440;
  const hour = String(Math.floor(withinDay / 60)).padStart(2,'0');
  const minutes = String(withinDay % 60).padStart(2,'0');
  return hour + ':' + minutes + (day === 1 ? ' next day' : day > 1 ? ' (+' + day + ' days)' : '');
}

export function primaryRunFirst                            (runs              , primaryJob         )               {
  if (primaryJob === undefined) return runs;
  const position = runs.findIndex(run => run.jobId === primaryJob);
  return position > 0 ? [runs[position], ...runs.slice(0, position), ...runs.slice(position + 1)] : runs;
}

export function freshnessDisplay(state                  , declaredInputs        ) {
  if (state === null) return { label: declaredInputs ? 'Not read' : 'No inputs declared', tone: '' };
  return { label: state, tone: ({Fresh: 'good', Stale: 'warn', Unknown: 'warn', Missing: 'bad'})[state] };
}

export function runStatusLabel(status                  ) {
  return status === 'DeadlineMissed' ? 'Deadline missed' : status;
}

export function waitOutcomeLabel(status                             ) {
  return status === 'ArtifactArrived' ? 'Artifact arrived' : status === 'DeadlineMissed' ? 'Deadline missed' : null;
}

export function policyArtifactLabel(gate                                             ) {
  const published = formatReplayMinute(gate.publishMinute);
  const checked = formatReplayMinute(gate.decisionMinute);
  return 'W' + gate.windowIndex + ' from ' + gate.producerAttemptId + '; ' +
    (published === checked ? 'published and checked at ' + published : 'published ' + published + ', checked ' + checked);
}

export function finishMargin(completion               , cutoff        ) {
  if (completion === null) return 'Did not finish';
  const margin = cutoff - completion;
  if (margin === 0) return 'At cutoff';
  return Math.abs(margin) + ' min ' + (margin > 0 ? 'before' : 'after');
}

export function comparePolicySummary(
  arrival        , cutoff        , onSchedule              , wait              , earliestFinish                = null,
)         {
  const deadline = formatReplayMinute(cutoff);
  const chosen = onSchedule.reads[0]?.actualWindowIndex;
  const used = chosen == null ? 'without a usable window' : 'using W' + chosen;
  const onScheduleResult = onSchedule.completionStatus === 'Success' && onSchedule.completionMinute !== null
    ? ' On schedule still finishes at ' + formatReplayMinute(onSchedule.completionMinute) + ' ' + used + '.'
    : '';
  if (wait.missReason === 'ArtifactNeverPublished') {
    return (arrival > cutoff
      ? 'The configured collector arrival is after the ' + deadline + ' cutoff, too late to start this report.'
      : 'No usable publication was observed by the ' + deadline + ' cutoff.') + onScheduleResult;
  }
  if (wait.missReason === 'CompletionWouldExceedCutoff') {
    const earliest = earliestFinish === null ? '' : ' Earliest possible finish: ' + formatReplayMinute(earliestFinish) + '.';
    return 'The fresh artifact arrives by ' + deadline + ', but there is not enough time to finish the report.' +
      earliest + onScheduleResult;
  }
  if (wait.completionStatus !== 'Success' || onSchedule.completionStatus !== 'Success' ||
      wait.completionMinute === null || onSchedule.completionMinute === null) return 'Compare the outcomes below.';
  const extra = wait.completionMinute - onSchedule.completionMinute;
  if (extra > 0 && wait.inputFreshnessStatus==='Fresh' && onSchedule.inputFreshnessStatus==='Stale') {
    const staleReason = onSchedule.reads[0]?.staleReason;
    const onScheduleCause = staleReason === 'PriorWindow' ? 'On schedule uses the prior window.'
      : staleReason === 'ExpiredExact' ? 'On schedule uses the right window past its freshness limit.'
      : 'On schedule uses stale data.';
    return 'Waiting gets fresh data but finishes ' + extra + (extra===1 ? ' minute' : ' minutes') +
      ' later. ' + onScheduleCause +
      (wait.completionMinute===cutoff ? ' Waiting finishes exactly at the cutoff.' : '');
  }
  if (extra===0 && wait.inputFreshnessStatus==='Fresh' && onSchedule.inputFreshnessStatus==='Fresh') {
    return 'Both policies get fresh data and finish together.';
  }
  return 'Compare the outcomes below.';
}

export function missReasonLabel(reason         )                {
  if (reason === 'ArtifactNeverPublished') return 'No usable publication by cutoff';
  if (reason === 'CompletionWouldExceedCutoff') return 'Not enough time to finish';
  return null;
}

export function cutoffArtifactExplanation(detail                        , cutoff        , ageLimit        )                {
  const published = detail.observedPublishMinute;
  if (typeof published !== 'number' || !Number.isSafeInteger(published) || published < 0 || published > cutoff) return null;
  const time = formatReplayMinute(published);
  if (detail.artifactAtCutoff === 'InvalidProducer') return 'Published at ' + time + ', but the producing attempt was invalid.';
  if (detail.artifactAtCutoff === 'Expired') {
    return 'Published at ' + time + ', but was ' + (cutoff - published) + ' min old at cutoff (limit: ' + ageLimit + ' min).';
  }
  return null;
}

export function waitResolutionLabel(kind        , minute        , run                          ) {
  if (run?.waitResolutionMinute !== minute) return null;
  if (kind === 'Admission') {
    return run.missReason === 'CompletionWouldExceedCutoff' && run.actualStart === null
      ? 'Not enough time to start and finish' : null;
  }
  if (kind !== 'WaitEnd' && kind !== 'DeadlineMiss') return null;
  if (run.missReason) return missReasonLabel(run.missReason);
  return kind === 'WaitEnd' && run.waitOutcome === 'ArtifactArrived' && run.actualStart === minute
    ? 'Fresh artifact; job started' : null;
}

export function completionWithoutEffect(status                              , hasOutput         )                {
  if (status === 'Failure') return hasOutput ? 'Failed without publishing' : 'Failed; no output declared';
  if (status === 'Success' && !hasOutput) return 'No output declared';
  return null;
}

export function outputEffectLabel(output                      )         {
  const target = output.key + ' W' + output.windowIndex;
  switch (output.kind) {
    case 'Accepted': return 'Accepted effect · ' + target;
    case 'Failed': return 'Failed without publishing ' + target;
    case 'Suppressed': return 'Suppressed effect for ' + target + '; duplicates ' + output.acceptedEffectId;
  }
}

export function readStateDetail(read                                                                         ) {
  switch (read.unavailableReason) {
    case 'InvalidProducer': return 'Unknown: producer invalid';
    case 'PublicationPending': return 'Unknown: publication not due yet';
    case 'NotAvailableAtRead': return 'Missing at read time';
  }
  if (read.staleReason === 'ExpiredExact') return 'Stale: freshness limit exceeded';
  if (read.staleReason === 'PriorWindow') return 'Stale: prior-window fallback';
  return read.state;
}

export function readAgeSummary(reads                                                    ) {
  let age                = null;
  for (const { artifactAge } of reads) {
    if (artifactAge !== null && (age === null || artifactAge > age)) age = artifactAge;
  }
  return { title: reads.length > 1 ? 'Oldest measured read age' : 'Age at Read', age };
}

export function freshnessDrivers(
  reads                                                                         ,
  summary                  ,
) {
  if (reads.length < 2 || summary === null || summary === 'Fresh') return null;
  const drivers = reads.filter(read => read.state === summary);
  if (!drivers.length) return null;
  const shown = drivers.slice(0, 3).map(read => read.key + ' W' + read.requiredWindow).join(', ');
  return drivers.length > 3 ? shown + ' and ' + (drivers.length - 3) + ' more' : shown;
}
