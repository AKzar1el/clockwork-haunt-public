import { simulate } from '../engine/simulator.ts';
import { buildEvidence } from '../export/evidence.ts';
import { ch01 } from '../fixtures/ch01.ts';
import { ch02 } from '../fixtures/ch02.ts';
import { ch03a, ch03b, ch03c } from '../fixtures/ch03.ts';
import { ch04Enabled, ch04Disabled } from '../fixtures/ch04.ts';
import type { ScenarioConfig, SimulationResult } from '../engine/types.ts';

type Case = { title: string; config: ScenarioConfig; note: string };
const cases: Record<string, Case[]> = {
  fresh: [{ title: 'On-time collector', config: ch01, note: 'The collector publishes at 08:04. The report reads the current window at 08:06.' }],
  late: [{ title: 'Late collector', config: ch02, note: 'The report finishes successfully using the previous window. The 08:12 publication cannot rewrite the earlier read.' }],
  wait: [
    { title: 'Arrives at 08:12', config: ch03a, note: 'Same late data, different policy. The report waits, reads fresh data at 08:12 and finishes at 08:14.' },
    { title: 'Never arrives', config: ch03b, note: 'Nothing usable arrives before the cutoff. The report never starts.' },
    { title: 'Arrives at 08:15', config: ch03c, note: 'The data arrives at the cutoff, but the report needs two minutes to run. It never starts.' },
  ],
  duplicate: [
    { title: 'Deduplication on', config: ch04Enabled, note: 'Two attempts, one accepted effect. The second attempt is retained as evidence, not as an output.' },
    { title: 'Deduplication off', config: ch04Disabled, note: 'Two attempts, two accepted effects. Compare the counts with deduplication enabled.' },
  ],
};

function get<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error('Missing UI control: ' + id);
  return el as T;
}

const scenario = get<HTMLSelectElement>('scenario');
const variant = get<HTMLSelectElement>('variant');
const variantLabel = get<HTMLElement>('variant-label');
const announcer = get<HTMLElement>('announcer');
let current: SimulationResult;

function esc(value: unknown): string {
  return String(value ?? '—').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c] ?? c);
}

function clock(minute: number | null) {
  if (minute === null) return '—';
  return String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
}

function fact(label: string, value: unknown, tone = '') {
  return '<div><dt>' + esc(label) + '</dt><dd class="' + tone + '">' + esc(value) + '</dd></div>';
}

function table(headers: string[], rows: unknown[][]) {
  return '<div class="scroll"><table><thead><tr>' +
    headers.map(h => '<th scope="col">' + esc(h) + '</th>').join('') +
    '</tr></thead><tbody>' +
    rows.map(row => '<tr>' + row.map(c => '<td>' + esc(c) + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></div>';
}

function panel(title: string, body: string) {
  return '<section class="panel"><h2>' + esc(title) + '</h2>' + body + '</section>';
}

function render(which: Case) {
  current = simulate(which.config);
  const result = current;
  const focusRuns = [...result.runs].sort((a, b) => Number(b.jobId.startsWith('report')) - Number(a.jobId.startsWith('report')));
  const runCards = focusRuns.map(run => {
    const statusTone = run.completionStatus === 'Success' ? 'good' : 'bad';
    const freshness = run.reads.length ? run.inputFreshnessStatus : null;
    const age = run.reads[0]?.artifactAge;
    let body = '<dl class="facts">' +
      fact('Run status', run.completionStatus, statusTone) +
      fact('Input freshness', freshness, freshness === 'Fresh' ? 'good' : freshness === 'Stale' ? 'warn' : '') +
      fact('Age at Read', age == null ? '—' : age + ' min') +
      fact('Started', clock(run.actualStart)) + fact('Finished', clock(run.completionMinute)) + '</dl>';
    if (run.waitStart !== null || run.missReason) {
      body += '<dl class="facts">' + fact('Wait started', clock(run.waitStart)) + fact('Data arrived', clock(run.waitEnd)) +
        fact('Wait outcome', run.waitOutcome) + fact('Miss reason', run.missReason) + '</dl>';
    }
    if (run.reads.length) body += table(['Input', 'Wanted', 'Used', 'Published', 'Read', 'Age at Read', 'State'],
      run.reads.map(read => [read.key, read.requiredWindow, read.actualWindowIndex, clock(read.publishMinute), clock(read.readMinute), read.artifactAge, read.state]));
    return panel(run.jobId, body);
  }).join('');
  const slots = result.slots.map(slot => '<div><h3 class="mono">' + esc(slot.key) + ' · W' + esc(slot.windowIndex) +
    '</h3><dl class="facts">' + fact('Attempts', slot.attemptCount) + fact('Effects', slot.effectCount) +
    (slot.acceptedEffectId ? fact('Accepted effect', slot.acceptedEffectId, 'good') : '') + '</dl></div>').join('');
  const traces = result.trace.map(t => '<li><code>' + esc(clock(t.eventMinute)) + '</code> <strong>' +
    esc(t.kind === 'Suppression' ? 'Suppressed' : t.kind) + '</strong> ' + esc(t.reportId) +
    (t.kind === 'Suppression' ? ' duplicated <strong>' + esc(t.detail.acceptedEffectId) + '</strong>' : '') +
    (t.kind === 'StaleRead' ? ' used window ' + esc(t.detail.fallbackWindow) + '; planned producer: ' + esc(t.detail.plannedCollectorId) : '') +
    (t.kind === 'DeadlineMiss' ? ': ' + esc(t.detail.missReason) : '') + '</li>').join('');
  const events = result.eventLog.map(e => {
    const suppressed = e.kind === 'Completion' && result.trace.find(t => t.kind === 'Suppression' && t.eventMinute === e.minute && t.reportId === e.entityId);
    const output = which.config.jobs.find(j => j.id === e.entityId)?.output;
    const outcome = suppressed ? 'Suppressed · duplicates ' + String(suppressed.detail.acceptedEffectId) :
      e.kind === 'Completion' && output ? 'Accepted effect · ' + output.key + ' W' + output.windowIndex : '';
    return [clock(e.minute), e.kind, e.entityId, e.sortKey, outcome];
  });
  get('report').innerHTML = panel(result.scenarioId + ' · ' + which.title, '<p class="muted">' + esc(which.note) + '</p>') +
    '<div class="columns">' + runCards + '</div>' +
    '<div class="columns">' + panel('Output slots', slots || '<p class="muted">No output effects.</p>') +
    panel('Incident trace', traces ? '<ul class="trace">' + traces + '</ul>' : '<p class="muted">No incidents in this replay.</p>') + '</div>' +
    panel('Deterministic event log', table(['Time', 'Event', 'Job or attempt', 'Sort key', 'Output outcome'], events));
  announcer.textContent = 'Replayed ' + result.scenarioId + ': ' + which.title;
}

function selected() {
  const group = cases[scenario.value] ?? cases.late;
  return group[Number(variant.value)] ?? group[0];
}

function changeScenario() {
  const group = cases[scenario.value] ?? cases.late;
  variant.replaceChildren(...group.map((item, i) => new Option(item.title, String(i))));
  variantLabel.hidden = group.length < 2;
  render(selected());
}

scenario.addEventListener('change', changeScenario);
variant.addEventListener('change', () => render(selected()));
get('replay').addEventListener('click', () => render(selected()));
get('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(buildEvidence(current), null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = current.scenarioId + '-evidence.json';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  announcer.textContent = 'Exported evidence for ' + current.scenarioId;
});
changeScenario();
