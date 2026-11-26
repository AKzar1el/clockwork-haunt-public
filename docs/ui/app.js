import { evidenceFromComparison, evidenceFromReplay, evaluateReplay } from '../export/evidence.js';
import { publishHintKey } from '../engine/classifier.js';
import { ch01 } from '../fixtures/ch01.js';
import { ch02, lateWithoutFallback } from '../fixtures/ch02.js';
import { ch03a, ch03b, ch03c, ch03ExpiredInput, ch03FailedCollector } from '../fixtures/ch03.js';
import { ch04Enabled, ch04Disabled } from '../fixtures/ch04.js';
import { evaluatePolicyComparison, selectComparisonRuns, isPolicyArrival, POLICY_ARRIVAL, POLICY_EXAMPLES } from '../fixtures/policy-comparison.js';
import { comparePolicySummary, completionWithoutEffect, cutoffArtifactExplanation, formatReplayMinute as clock, finishMargin, freshnessDisplay, freshnessDrivers, missReasonLabel, outputEffectLabel, policyArtifactLabel, primaryRunFirst, readAgeSummary, readStateDetail, runStatusLabel, scopedReplayUrl, waitOutcomeLabel, waitResolutionLabel } from './presentation.js';
                                                         

// Variant values are persisted in replay links. Keep assigned IDs stable
// when option order changes or a new preset is inserted.
                                                                                
const primaryJobByGroup                                  = { fresh:'report-w1', late:'report-w1', wait:'report-w1' };
const cases                         = {
  fresh: [{ id: '0', title: 'On-time collector', config: ch01, note: 'The collector publishes at 08:04. The report reads the current window at 08:06.' }],
  late: [
    { id: '0', title: 'Use the previous window', config: ch02, note: 'The report finishes successfully using the previous window. The 08:12 publication cannot rewrite the earlier read.' },
    { id: '1', title: 'Do not fall back', config: lateWithoutFallback(), note: 'The report still runs on schedule. At read time, the current window is not due yet, so the input is Unknown. The later publication does not change that observation.' },
  ],
  wait: [
    { id: '0', title: 'Arrives at 08:12', config: ch03a, note: 'The report waits, reads fresh data at 08:12 and finishes at 08:14. The policy lab holds inputs constant for a direct comparison.' },
    { id: '1', title: 'Never arrives', config: ch03b, note: 'Nothing usable arrives before the cutoff. The report never starts.' },
    { id: '2', title: 'Arrives at 08:15', config: ch03c, note: 'The data arrives at the cutoff, but the report needs two minutes to run. It never starts.' },
    { id: '3', title: 'Collector fails', config: ch03FailedCollector, note: 'The collector runs but fails before publishing. The report waits until its cutoff.' },
    { id: '4', title: 'Input is already too old', config: ch03ExpiredInput, note: 'The requested window already exists, but its data is too old. With no new publication, the report never starts.' },
  ],
  duplicate: [
    { id: '0', title: 'Deduplication on', config: ch04Enabled, note: 'Two attempts, one accepted effect. The second attempt is retained as evidence, not as an output.' },
    { id: '1', title: 'Deduplication off', config: ch04Disabled, note: 'Two attempts, two accepted effects. Compare the counts with deduplication enabled.' },
  ],
};

function get                       (id        )    {
  const el = document.getElementById(id);
  if (!el) throw new Error('Missing UI control: ' + id);
  return el     ;
}

const scenario = get                   ('scenario');
const variant = get                   ('variant');
const variantLabel = get             ('variant-label');
const announcer = get             ('announcer');
let renderedReplay                                                                                     ;
let renderedConfig                ;

function esc(value         )         {
  return String(value ?? '—').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c] ?? c);
}

function fact(label        , value         , tone = '') {
  return '<div><dt>' + esc(label) + '</dt><dd class="' + tone + '">' + esc(value) + '</dd></div>';
}

let tableHintSequence = 0;
function table(headers          , rows             , name        , rowHeadings = false) {
  const hint = 'table-scroll-hint-' + ++tableHintSequence;
  return '<p class="table-scroll-hint muted" id="' + hint + '" hidden>Scroll sideways for more columns.</p>' +
    '<div class="scroll" tabindex="-1" role="region" aria-label="' + esc(name) + '"><table><caption class="sr">' + esc(name) + '</caption><thead><tr>' +
    headers.map(h => '<th scope="col">' + esc(h) + '</th>').join('') +
    '</tr></thead><tbody>' +
    rows.map(row => '<tr>' + row.map((cell, col) => rowHeadings && col === 0
      ? '<th scope="row">' + esc(cell) + '</th>' : '<td>' + esc(cell) + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></div>';
}

function panel(title        , body        ) {
  return '<section class="panel"><h2>' + esc(title) + '</h2>' + body + '</section>';
}

function updateScrollTabStops(container             ) {
  for (const region of container.querySelectorAll             ('.scroll')) {
    const overflows = region.scrollWidth > region.clientWidth;
    region.tabIndex = overflows ? 0 : -1;
    const hint = region.previousElementSibling;
    if (hint instanceof HTMLElement && hint.classList.contains('table-scroll-hint')) {
      hint.hidden = !overflows;
      if (overflows) region.setAttribute('aria-describedby', hint.id);
      else region.removeAttribute('aria-describedby');
    }
  }
}

function replacePanelContent(container             , markup        , control             ) {
  const active = document.activeElement;
  const previous = active !== null && container.contains(active)
    ? active.closest             ('[role="region"][tabindex]') : null;
  const name = previous?.getAttribute('aria-label');
  const left = previous?.scrollLeft ?? 0;
  const top = previous?.scrollTop ?? 0;
  container.innerHTML = markup;
  updateScrollTabStops(container);
  if (!previous) return;
  const replacement = [...container.querySelectorAll             ('[role="region"][tabindex]')]
    .find(region => region.getAttribute('aria-label') === name);
  if (replacement) {
    replacement.focus({preventScroll:true});
    replacement.scrollLeft = left;
    replacement.scrollTop = top;
  } else control.focus();
}

const arrivalControl = get                  ('arrival');
arrivalControl.min = String(POLICY_ARRIVAL.min);
arrivalControl.max = String(POLICY_ARRIVAL.max);
get('arrival-range').textContent = clock(POLICY_ARRIVAL.min) + ' to ' + clock(POLICY_ARRIVAL.max);
let renderedComparison                                                         ;
let lastPresentedArrival                    ;

function clearDownloadFeedback(id        ) {
  get(id).textContent = '';
}

function renderComparison() {
  const arrival = arrivalControl.valueAsNumber;
  if (arrival === renderedComparison?.arrival) return;
  const evaluation = evaluatePolicyComparison(arrival);
  const result = selectComparisonRuns(evaluation);
  clearDownloadFeedback('comparison-feedback');
  const freshnessRule = get('policy-freshness-rule');
  const rule = 'Fresh requires a valid publication for the requested window. When checked, it can be no more than ' +
    evaluation.input.wait.maxArtifactAge + ' minutes old. A prior window is still stale, even within that age limit.';
  if (freshnessRule.textContent !== rule) freshnessRule.textContent = rule;
  freshnessRule.hidden = false;
  const cutoff = clock(result.cutoff);
  const onScheduleRead = result.fallback.reads[0];
  const waitRead = result.wait.reads[0];
  const gate = result.wait.policyArtifact;
  const usedWindow = (read                                   ) =>
    !read ? 'Not read' : read.actualWindowIndex === null ? 'No window used' : 'W' + read.actualWindowIndex;
  const readAttempt = (read                                   ) =>
    read ? read.producerAttemptId ?? 'No artifact used' : 'Not read';
  const timeOr = (minute                           , unavailable        ) =>
    minute == null ? unavailable : clock(minute);
  const readAge = (read                                   ) =>
    read ? read.artifactAge ?? 'Unavailable' : 'Not read';
  const rows = [
    ['Report starts', timeOr(result.fallback.actualStart,'Not started'), timeOr(result.wait.actualStart,'Not started')],
    ['Report finishes', timeOr(result.fallback.completionMinute,'Did not finish'), timeOr(result.wait.completionMinute,'Did not finish')],
    ['Input freshness', freshnessDisplay(result.fallback.inputFreshnessStatus, 1).label, freshnessDisplay(result.wait.inputFreshnessStatus, 1).label],
    ['Window used', usedWindow(onScheduleRead), usedWindow(waitRead)],
    ['Read from attempt', readAttempt(onScheduleRead), readAttempt(waitRead)],
    ['Fresh artifact for wait policy', 'No wait policy',
      gate ? policyArtifactLabel(gate) : 'None observed'],
    ['Read at', timeOr(onScheduleRead?.readMinute,'Not read'), timeOr(waitRead?.readMinute,'Not read')],
    ['Read age (minutes)', readAge(onScheduleRead), readAge(waitRead)],
    ['Run outcome', runStatusLabel(result.fallback.completionStatus), runStatusLabel(result.wait.completionStatus)],
    ['Finish relative to ' + cutoff, finishMargin(result.fallback.completionMinute, result.cutoff),
      finishMargin(result.wait.completionMinute, result.cutoff)],
  ];
  const explanation = comparePolicySummary(result.arrival,result.cutoff,result.fallback,result.wait,result.earliestFinish);
  replacePanelContent(get('comparison'), '<p id="policy-summary"><strong>What changes:</strong> ' + esc(explanation) + '</p>' +
    table(['Measure', 'Run on schedule', 'Wait for fresh'], rows, 'Policy comparison', true), arrivalControl);
  renderedComparison = evaluation;
}
function tryRenderComparison() {
  const button = get                   ('export-comparison');
  const retry = get                   ('retry-comparison');
  lastPresentedArrival = arrivalControl.valueAsNumber;
  const selectedTime = clock(lastPresentedArrival);
  if (arrivalControl.getAttribute('aria-valuetext') !== selectedTime) {
    get('arrival-time').textContent = selectedTime;
    arrivalControl.setAttribute('aria-valuetext',selectedTime);
  }
  get('policy-announcer').textContent = '';
  try {
    renderComparison();
    button.disabled = false;
    if (document.activeElement === retry) arrivalControl.focus({preventScroll:true});
    retry.hidden = true;
  } catch {
    renderedComparison = undefined;
    button.disabled = true;
    retry.hidden = false;
    clearDownloadFeedback('comparison-feedback');
    replacePanelContent(get('comparison'),
      '<p class="muted" role="alert">This comparison could not run. Retry this arrival or choose a different time.</p>',
      arrivalControl);
  } finally {
    updateShareLink();
  }
}
arrivalControl.addEventListener('input', tryRenderComparison);

function render(which      ) {
  if (renderedConfig !== which.config) clearDownloadFeedback('export-feedback');
  const replay = evaluateReplay(which.config);
  const { input, result } = replay;
  const definitionByJob = new Map(input.jobs.map(job => [job.id, job]));
  const outputByJob = new Map               ();
  for (const event of result.eventLog) {
    const output = event.completion?.output;
    if (output) outputByJob.set(event.entityId,outputEffectLabel(output));
  }
  const focusRuns = primaryRunFirst(result.runs, primaryJobByGroup[scenario.value]);
  const runCards = focusRuns.map(run => {
    const statusTone = run.completionStatus === 'Success' ? 'good' : 'bad';
    const job = definitionByJob.get(run.jobId);
    const freshness = run.inputFreshnessStatus;
    const inputDisplay = freshnessDisplay(freshness, job?.inputs.length ?? 0);
    const readAge = readAgeSummary(run.reads);
    const drivers = freshnessDrivers(run.reads, freshness);
    let body = '<dl class="facts">' +
      fact('Run status', runStatusLabel(run.completionStatus), statusTone) +
      (job?.output ? fact('Output effect', outputByJob.get(run.jobId) ??
        'Not published: ' + job.output.key + ' W' + job.output.windowIndex) : '') +
      fact('Input freshness', inputDisplay.label, inputDisplay.tone) +
      fact(readAge.title, readAge.age === null ? '—' : readAge.age + ' min') +
      fact('Scheduled start', clock(run.scheduledStart)) +
      fact('Started', run.actualStart === null ? 'Not started' : clock(run.actualStart)) +
      fact('Finished', run.completionMinute === null ? 'Did not finish' : clock(run.completionMinute)) + '</dl>';
    if (drivers) {
      body += '<dl class="facts">' + fact('Inputs driving freshness status', drivers) + '</dl>';
    }
    if (job?.waitPolicy) {
      const policy = job.waitPolicy;
      const gate = run.policyArtifact;
      body += '<dl class="facts">' + fact('Wait target', policy.key + ' W' + policy.requiredWindow) +
        fact('Finish cutoff', clock(policy.deadline)) + fact('Run time needed', job.runDuration + ' min') +
        (gate ? fact('Fresh policy artifact', policyArtifactLabel(gate))
          : '') + '</dl>';
    }
    if (run.waitStart !== null || run.missReason) {
      body += '<dl class="facts">' + fact('Wait started', run.waitStart === null ? 'No wait recorded' : clock(run.waitStart)) +
        fact('Usable publication', run.waitEnd === null ? 'None by resolution' : clock(run.waitEnd)) +
        fact('Policy resolved', clock(run.waitResolutionMinute)) +
        (run.waitStart !== null && run.waitResolutionMinute !== null
          ? fact('Time spent waiting', (run.waitResolutionMinute - run.waitStart) + ' min') : '') +
        fact('Wait outcome', waitOutcomeLabel(run.waitOutcome)) + fact('Miss reason', missReasonLabel(run.missReason)) + '</dl>';
    }
    if (run.reads.length) body += table(['Input', 'Wanted', 'Used', 'Producer attempt', 'Published', 'Read', 'Age at Read', 'State'],
      run.reads.map(read => {
        const hinted = read.unavailableReason === 'PublicationPending'
          ? job?.scheduledPublishMinutes?.[publishHintKey(read.key,read.requiredWindow)] : undefined;
        const detail = readStateDetail(read) + (hinted === undefined ? '' : ' (scheduled for ' + clock(hinted) + ')');
        return [read.key, read.requiredWindow, read.actualWindowIndex, read.producerAttemptId, clock(read.publishMinute),
          clock(read.readMinute), read.artifactAge, detail];
      }), 'Inputs for ' + run.jobId);
    return panel(run.jobId, body);
  }).join('');
  const outputIdentity = (key                , window       ) => JSON.stringify([key,window]);
  const dedupBySlot = new Map                ();
  for (const job of input.jobs) {
    if (job.output) dedupBySlot.set(outputIdentity(job.output.key,job.output.windowIndex), job.deduplicationEnabled ?? true);
  }
  const slots = result.slots.map(slot => {
    const dedup = dedupBySlot.get(outputIdentity(slot.key,slot.windowIndex));
    return '<div><h3 class="mono">' + esc(slot.key) + ' · W' + esc(slot.windowIndex) +
      '</h3><dl class="facts">' + fact('Attempts', slot.attemptCount) + fact('Effects', slot.effectCount) +
      fact('Deduplication', dedup === undefined ? null : dedup ? 'On' : 'Off') +
      fact('Suppressed attempts', slot.suppressedAttempts.length) +
      (slot.acceptedEffectId ? fact('Canonical accepted attempt', slot.acceptedEffectId, 'good') : '') + '</dl></div>';
  }).join('');
  const traces = result.trace.map(t => {
    const cutoffArtifact = t.kind === 'DeadlineMiss' ? cutoffArtifactExplanation(t.detail,t.eventMinute,input.maxArtifactAge) : null;
    return '<li><code>' + esc(clock(t.eventMinute)) + '</code> <strong>' +
    esc(t.kind === 'Suppression' ? 'Suppressed' : t.kind) + '</strong> ' + esc(t.reportId) +
    (t.kind === 'Suppression' ? ' duplicated <strong>' + esc(t.detail.acceptedEffectId) + '</strong>' : '') +
    (t.kind === 'StaleRead' ? ' requested ' + esc(t.detail.key) + ' W' + esc(t.detail.requiredWindow) +
      '; read W' + esc(t.detail.fallbackWindow) +
      (t.detail.plannedCollectorId == null ? '; no producer configured' : '; planned producer: ' + esc(t.detail.plannedCollectorId)) +
      '; actual producer attempt: ' + esc(t.detail.producerAttemptId) +
      (t.detail.staleReason === 'ExpiredExact' ? '; current window exceeded freshness limit' : '; prior-window fallback') : '') +
    (t.kind === 'BlockedWait' || t.kind === 'DeadlineMiss'
      ? ' for ' + esc(t.detail.key) + ' W' + esc(t.detail.requiredWindow) +
        (t.detail.plannedCollectorId == null ? '; no producer configured' : '; planned producer: ' + esc(t.detail.plannedCollectorId))
      : '') +
    (t.kind === 'DeadlineMiss' ? ' (' + esc(missReasonLabel(t.detail.missReason)) + ')' : '') +
    (t.kind === 'DeadlineMiss' && t.detail.missReason === 'CompletionWouldExceedCutoff'
      ? '; usable publication at ' + esc(clock(Number(t.detail.observedPublishMinute))) +
        ' from ' + esc(t.detail.observedProducerAttemptId) +
        '; earliest finish ' + esc(clock(Number(t.detail.earliestFinish))) +
        ' exceeds ' + esc(clock(Number(t.detail.finishCutoff))) : '') +
    (cutoffArtifact ? '. ' + esc(cutoffArtifact) : '') +
    (t.kind === 'DeadlineMiss' && t.detail.artifactAtCutoff === 'ProducerFailed' ? '; planned producer failed before publishing' : '') +
    '</li>';
  }).join('');
  const runsByJob = new Map(result.runs.map(run=>[run.jobId,run]));
  const events = result.eventLog.map(e => {
    const output = e.completion?.output;
    const outcome = output ? (outputByJob.get(e.entityId) ?? '') :
      completionWithoutEffect(e.completion?.outcome, false) ??
      waitResolutionLabel(e.kind,e.minute,runsByJob.get(e.entityId)) ?? '';
    return [clock(e.minute), e.kind, e.entityId, e.sortKey, outcome];
  });
  const noSlots = !dedupBySlot.size ? 'No outputs are declared for this replay.' :
    result.eventLog.some(e=>e.completion?.output?.kind==='Failed')
      ? 'No output was published. A job with a declared output failed.'
      : 'No declared output was published during this replay.';
  replacePanelContent(get('report'), panel(result.scenarioId + ' · ' + which.title, '<p class="muted">' + esc(which.note) + '</p>') +
    '<div class="columns">' + runCards + '</div>' +
    '<div class="columns">' + panel('Output slots', slots || '<p class="muted">' + esc(noSlots) + '</p>') +
    panel('Incident trace', traces ? '<ul class="trace">' + traces + '</ul>' : '<p class="muted">No incident trace entries.</p>') + '</div>' +
    panel('Deterministic event log',
      '<p class="muted">At the same minute, completions and publications happen first, then scheduled admissions, then wait checks, then cutoffs. Job ID breaks ties within each step.</p>' +
      table(['Time', 'Event', 'Job or attempt', 'Sort key', 'Outcome'], events, 'Deterministic event log') +
      '<a id="return-to-replay" class="panel-link" href="#replay-title">Back to replay controls</a>'), scenario);
  renderedReplay = { ...replay, scenario:scenario.value, variant:which.id };
  renderedConfig = which.config;
  announcer.textContent = 'Replayed ' + result.scenarioId + ': ' + which.title;
}

function selected() {
  const group = cases[scenario.value] ?? cases.late;
  return group.find(item => item.id === variant.value) ?? group[0];
}

function tryRenderReplay(which      )          {
  const button = get                   ('export');
  try {
    render(which);
    button.disabled = false;
    return true;
  } catch {
    renderedReplay = undefined;
    renderedConfig = undefined;
    button.disabled = true;
    clearDownloadFeedback('export-feedback');
    announcer.textContent = '';
    replacePanelContent(get('report'),
      '<p class="panel" role="alert">This replay could not run. Try Replay again or choose another preset.</p>',
      scenario);
    return false;
  } finally {
    updateShareLink();
  }
}

let displayedVariants                    ;
function changeScenario(initialVariant = '0') {
  const group = cases[scenario.value] ?? cases.late;
  if (displayedVariants !== group) {
    variant.replaceChildren(...group.map(item => new Option(item.title, item.id)));
    displayedVariants = group;
  }
  variant.value = group.find(item => item.id === initialVariant)?.id ?? group[0].id;
  const hideVariant = group.length < 2;
  if (hideVariant && document.activeElement === variant) scenario.focus({ preventScroll: true });
  variantLabel.hidden = hideVariant;
  const choice = selected();
  return choice.config === renderedConfig || tryRenderReplay(choice);
}

function setReplayParams(url     )             {
  if (!renderedReplay || !renderedComparison) return null;
  url.searchParams.set('scenario', renderedReplay.scenario);
  url.searchParams.set('variant', renderedReplay.variant);
  url.searchParams.set('arrival', String(renderedComparison.arrival));
  return url;
}

let shareCopyRevision = 0;
function clearShareFeedback() {
  shareCopyRevision++;
  get('share-feedback').textContent = '';
}

function setShareExpanded(expanded         , returnFocus = false) {
  const share = get                   ('show-replay-link');
  get('share-tools').hidden = !expanded;
  share.setAttribute('aria-expanded', String(expanded));
  share.textContent = expanded ? 'Hide replay link' : 'Show replay link';
  if (!expanded) clearShareFeedback();
  if (returnFocus) (share.disabled ? get('replay') : share).focus({preventScroll:true});
}

function updateShareLink() {
  const share = get                   ('show-replay-link');
  const tools = get('share-tools');
  const link = get                  ('replay-link');
  const unavailable = get('share-unavailable');
  const active = document.activeElement;
  const moveFocus = active === share || tools.contains(active);
  share.disabled = !renderedReplay || !renderedComparison;
  const explain = share.disabled && lastPresentedArrival !== undefined;
  unavailable.hidden = !explain;
  if (explain) {
    unavailable.textContent = !renderedReplay && !renderedComparison
      ? 'To share a link, run the replay again and retry the policy comparison.'
      : !renderedReplay
        ? 'Replay again or choose another preset to restore sharing.'
        : 'Retry the policy comparison to restore sharing.';
    share.setAttribute('aria-describedby',unavailable.id);
  } else {
    unavailable.textContent = '';
    share.removeAttribute('aria-describedby');
  }
  if (share.disabled) {
    setShareExpanded(false);
    link.value = '';
    // Sharing just lost its focused control. Let native focus reveal the
    // recovery control, which may be in a different panel below the viewport.
    if (moveFocus) (renderedReplay ? arrivalControl : get('replay')).focus();
    return;
  }
  if (tools.hidden) return;
  const url = scopedReplayUrl(location.href);
  const next = setReplayParams(url)?.href ?? '';
  if (link.value !== next) {
    link.value = next;
    clearShareFeedback();
  }
}

function saveReplayLocation() {
  if (renderedComparison?.arrival !== arrivalControl.valueAsNumber) return;
  const url = setReplayParams(new URL(location.href));
  if (!url) return;
  updateShareLink();
  try {
    if (url.href !== location.href) history.pushState(null, '', url);
    updateLocationFeedback([]);
  } catch {
    showLocationFeedback('Browser history could not update. The visible replay and its share link still work.');
  }
}

scenario.addEventListener('change', () => { if (changeScenario()) saveReplayLocation(); });
variant.addEventListener('change', () => { if (tryRenderReplay(selected())) saveReplayLocation(); });
arrivalControl.addEventListener('change', () => {
  // A committed change can arrive without a preceding input event. Don't
  // repaint or auto-retry when input already attempted this same minute.
  if (arrivalControl.valueAsNumber !== lastPresentedArrival) tryRenderComparison();
  saveReplayLocation();
});
get('retry-comparison').addEventListener('click',()=>{
  tryRenderComparison();
  if (!renderedComparison) return;
  get('policy-announcer').textContent = get('policy-summary').textContent;
  saveReplayLocation();
});
for (const [id, minute] of [['show-tradeoff', POLICY_EXAMPLES.tradeoff], ['show-cutoff-miss',POLICY_EXAMPLES.cutoffMiss]]         ) {
  const button = get                   (id);
  if (minute === null) {
    button.hidden = true;
    continue;
  }
  button.disabled = false;
  button.addEventListener('click', () => {
    arrivalControl.valueAsNumber = minute;
    tryRenderComparison();
    if (renderedComparison) {
      get('policy-announcer').textContent = get('policy-summary').textContent;
    }
    saveReplayLocation();
  });
}
get('replay').addEventListener('click', () => {
  const recovering = renderedReplay === undefined;
  const pendingLocationNotice = Boolean(get('replay-location-feedback').textContent);
  if (tryRenderReplay(selected()) && (recovering || pendingLocationNotice)) saveReplayLocation();
});
get('show-replay-link').addEventListener('click', () => {
  if (!get('share-tools').hidden) {
    setShareExpanded(false,true);
    return;
  }
  setShareExpanded(true);
  updateShareLink();
  const field = get                  ('replay-link');
  field.focus();
  field.select();
});
get('share-tools').addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  setShareExpanded(false,true);
});
get('copy-replay-link').addEventListener('click', async () => {
  const field = get                  ('replay-link');
  const originFocus = document.activeElement;
  const tools = get('share-tools');
  const feedback = get('share-feedback');
  const value = field.value;
  const revision = ++shareCopyRevision;
  const stillCurrent = () => revision === shareCopyRevision && !get('share-tools').hidden && field.value === value;
  if (!value || get('share-tools').hidden) return;
  feedback.textContent = 'Copying replay link…';
  const pendingNotice = window.setTimeout(()=>{
    if (stillCurrent()) feedback.textContent = 'Still waiting for the browser. Select the link to copy it manually.';
  },1200);
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(value);
    if (stillCurrent()) feedback.textContent = 'Replay link copied.';
  } catch {
    if (!stillCurrent()) return;
    const moveFocus = originFocus === document.activeElement && tools.contains(originFocus);
    if (moveFocus) {
      field.focus();
      field.select();
    }
    feedback.textContent = moveFocus
      ? 'Could not copy automatically. The link is selected so you can copy it manually.'
      : 'Could not copy automatically. Select the link to copy it manually.';
  } finally {
    window.clearTimeout(pendingNotice);
  }
});
function downloadJson(produce               , filename        , feedbackId        ) {
  const feedback = get(feedbackId);
  const anchor = document.createElement('a');
  let url                    ;
  let handedOff = false;
  try {
    const blob = new Blob([JSON.stringify(produce(), null, 2) + '\n'], { type: 'application/json' });
    url = URL.createObjectURL(blob);
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    handedOff = true;
    feedback.textContent = 'Download requested: ' + filename;
  } catch {
    feedback.textContent = 'Could not start the JSON download. Try again or check your browser download settings.';
  } finally {
    anchor.remove();
    if (url !== undefined) {
      const requestedUrl = url;
      // A started download still needs time to take ownership. A failed
      // handoff has no browser consumer and need not keep the blob alive.
      if (handedOff) setTimeout(() => URL.revokeObjectURL(requestedUrl), 1000);
      else URL.revokeObjectURL(requestedUrl);
    }
  }
}
get('export').addEventListener('click', () => {
  const replay = renderedReplay;
  if (!replay) return;
  downloadJson(() => evidenceFromReplay(replay), replay.result.scenarioId + '-evidence.json', 'export-feedback');
});
get('export-comparison').addEventListener('click', () => {
  const comparison = renderedComparison;
  if (!comparison) return;
  downloadJson(() => evidenceFromComparison(comparison),
    'clockwork-policy-comparison-' + clock(comparison.arrival).replace(':', '') + '.json', 'comparison-feedback');
});
function showLocationFeedback(message        ) {
  get('replay-location-feedback').textContent = message;
}

function updateLocationFeedback(reset          ) {
  showLocationFeedback(reset.length ? 'This replay link has unsupported settings. Defaults used for: ' + reset.join(', ') + '.' : '');
}

function restoreReplayLocation() {
  const params = new URLSearchParams(location.search);
  const readOne = (key        ) => {
    const values = params.getAll(key);
    return { supplied: values.length > 0, value: values.length === 1 ? values[0] : null };
  };
  const reset           = [];
  const scenarioParam = readOne('scenario');
  const requested = scenarioParam.value;
  const knownScenario = requested !== null && Object.hasOwn(cases, requested);
  scenario.value = knownScenario ? requested : 'late';
  if (scenarioParam.supplied && !knownScenario) reset.push('scenario');
  const variantParam = readOne('variant');
  const requestedVariant = variantParam.value;
  const knownVariant = requestedVariant !== null && (!scenarioParam.supplied || knownScenario) &&
    cases[scenario.value].some(item => item.id === requestedVariant);
  if (variantParam.supplied && !knownVariant) reset.push('variant');
  const arrivalParam = readOne('arrival');
  const arrival = arrivalParam.value;
  const minute = arrival === null ? NaN : Number(arrival);
  const valid = isPolicyArrival(minute) && String(minute) === arrival;
  if (arrivalParam.supplied && !valid) reset.push('arrival');
  arrivalControl.valueAsNumber = valid ? minute : POLICY_ARRIVAL.initial;
  changeScenario(knownVariant ? requestedVariant : '0');
  tryRenderComparison();
  updateShareLink();
  updateLocationFeedback(reset);
}
window.addEventListener('popstate', restoreReplayLocation);
restoreReplayLocation();
if (typeof ResizeObserver === 'function') {
  const scrollObserver = new ResizeObserver(entries => {
    for (const { target } of entries) updateScrollTabStops(target               );
  });
  scrollObserver.observe(get('report'));
  scrollObserver.observe(get('comparison'));
} else {
  window.addEventListener('resize', () => {
    updateScrollTabStops(get('report'));
    updateScrollTabStops(get('comparison'));
  });
}
for (const id of ['scenario', 'variant', 'replay', 'arrival']) get                  (id).disabled = false;
get('view-replay-results').hidden = false;
get('startup-loading').hidden = true;
document.documentElement.dataset.ready = 'true';
