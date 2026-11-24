# Technical Design Document

## Feature: Scenario-Artifact Contracts

---

## 1. Overview

This document covers the internal design for the Scenario-Artifact Contracts feature of Clockwork Haunt. The deliverable is a browser-only TypeScript module that:

1. Accepts a declarative JSON scenario configuration.
2. Runs a fully deterministic single-clock simulation and produces an immutable event log.
3. Evaluates every artifact read against the four mutually exclusive read states (Fresh, Stale, Missing, Unknown).
4. Models Wait Policy blocking, late admission with the Finish Cutoff gate, and deadline misses.
5. Tracks deduplication — accepted effects vs. suppressed attempts — per logical output key slot.
6. Generates structured trace entries at event time without rewriting earlier records.
7. Exposes a timestamp-free canonical evidence bundle as JSON.
8. Renders results in a minimal, static browser UI built with a real static build step.

No server or external service is involved. All simulation logic is pure TypeScript. The static build step compiles and bundles it into a single `dist/bundle.js` that the browser loads.

---

## 2. Module Boundaries

```
src/
  engine/
    types.ts          — all shared TypeScript types (no logic)
    store.ts          — ArtifactStore: append-only artifact record map
    classifier.ts     — read-state classifier (Fresh/Stale/Unknown/Missing)
    scheduler.ts      — event queue builder and sorted-queue type
    simulator.ts      — top-level simulate() function; owns event loop
    tie-break.ts      — sortKey() and comparator used throughout
    dedup.ts          — deduplication guard per key+window slot
    tracer.ts         — appendTrace(); never mutates existing entries
  fixtures/
    ch01.ts           — CH-01 scenario config
    ch02.ts           — CH-02 scenario config
    ch03.ts           — CH-03 scenario config (three variants: a/b/c)
    ch04.ts           — CH-04 scenario config (two variants: enabled/disabled)
  tests/
    ch01.test.ts
    ch02.test.ts
    ch03.test.ts
    ch04.test.ts
    classifier.test.ts
    tie-break.test.ts
    dedup.test.ts
    evidence.test.ts
    simulator.test.ts     — same-minute phase ordering and exactly-one-completion invariants
  export/
    evidence.ts       — buildEvidence(): serialises SimulationResult to EvidenceBundle
  ui/
    app.ts            — wires fixture selector → simulate() → render()
    render.ts         — pure DOM-building functions; no state
  index.html          — single page; loads dist/bundle.js
dist/
  bundle.js           — output of the static build; committed or generated locally
```

Each module has one responsibility and no circular imports. `types.ts` is imported by everything; nothing imports `simulator.ts` except `app.ts` and the test files.

---

## 3. Core Types

```ts
// types.ts (illustrative — not implementation code)

type Minute = number; // integer in [0, 1439]

type ReadState = 'Fresh' | 'Stale' | 'Unknown' | 'Missing';

type CompletionStatus = 'Success' | 'Failure' | 'Blocked' | 'DeadlineMissed';

type InputFreshnessStatus = 'Fresh' | 'Stale' | 'Unknown' | 'Missing';

type WaitOutcome = 'ArtifactArrived' | 'DeadlineMissed';

type MissReason = 'ArtifactNeverPublished' | 'CompletionWouldExceedCutoff';

// EventLogEntry.typePriority values — correspond directly to per-minute phases:
//   1 = Completion   (Phase 1: finish running jobs; dedup; accepted outputs become visible)
//   2 = Admission    (Phase 2: start new jobs; evaluate reads against Phase-1-visible store)
//   3 = WaitEnd      (Phase 2: resolve eligible blocked jobs, same phase as Admission)
//   4 = DeadlineMiss (Phase 3: expire unresolved deadlines)
// Publication is not a separate queue entry. Making an accepted output visible is the
// direct result of a Completion event; suppressed outputs are never added to the store.
type EventTypePriority = 1 | 2 | 3 | 4;

interface ArtifactRecord {
  key: string;
  windowIndex: number;
  publishMinute: Minute;    // = actualStart + runDuration of the producing job
  attemptId: string;
  producerValid: boolean;   // false if the producing attempt is recorded as failed/invalid
}

interface WaitPolicy {
  key: string;
  requiredWindow: number;
  deadline: Minute;         // inclusive Finish Cutoff; equals the job's deadline
}
// Note: WaitPolicy carries no runDuration. The single runDuration on JobDefinition
// is used for both normal execution timing and the admission-gate calculation.

interface JobDefinition {
  id: string;
  scheduledStart: Minute;
  runDuration: number;              // positive integer minutes; one value used everywhere
  inputs: Array<{ key: string; requiredWindow: number }>;
  output?: { key: string; windowIndex: number };
  waitPolicy?: WaitPolicy;
  fallbackEnabled?: boolean;        // enables prior-window Stale fallback for this job
  deduplicationEnabled?: boolean;   // scoped to this job's output slot
  scheduledPublishMinutes?: Record<string, Minute>;
  // key → minute at which a producer is expected to publish; used for Unknown classification
}

interface ArtifactReadRecord {
  jobId: string;
  attemptId: string;
  key: string;
  requiredWindow: number;
  actualWindowIndex: number | null;
  state: ReadState;
  publishMinute: Minute | null;
  readMinute: Minute;          // immutable after creation; stamped at classify time
  artifactAge: number | null;  // readMinute − publishMinute; null if Missing or Unknown
}

interface JobRunRecord {
  jobId: string;
  attemptId: string;
  scheduledStart: Minute;
  actualStart: Minute | null;        // minute execution began (effectiveStart)
  completionMinute: Minute | null;   // actualStart + runDuration; null until job completes
  completionStatus: CompletionStatus;
  inputFreshnessStatus: InputFreshnessStatus | null;
  waitStart: Minute | null;          // scheduledStart when a Wait Policy is active
  waitEnd: Minute | null;            // minute the artifact became available (T_pub)
  actualStartMinute: Minute | null;  // effectiveStart = max(scheduledStart, T_pub)
  waitOutcome: WaitOutcome | null;
  missReason: MissReason | null;
  reads: ArtifactReadRecord[];       // frozen; populated at Admission event
}

interface KeySlot {
  key: string;
  windowIndex: number;
  attemptCount: number;
  effectCount: number;
  acceptedEffectId: string | null;
  suppressedAttempts: SuppressedAttemptRecord[];
}

interface SuppressedAttemptRecord {
  attemptId: string;
  suppressedAtMinute: Minute;   // the Completion minute of the suppressed attempt
  acceptedEffectId: string;
  reason: 'duplicate-output-key';
}

interface TraceEntry {
  eventMinute: Minute;
  kind: 'StaleRead' | 'BlockedWait' | 'DeadlineMiss' | 'Suppression';
  reportId: string;
  detail: Record<string, unknown>; // plain snapshot; no mutable references
}

interface SimulationResult {
  scenarioId: string;
  runs: JobRunRecord[];
  slots: KeySlot[];
  trace: TraceEntry[];
  eventLog: EventLogEntry[];
}

interface EventLogEntry {
  minute: Minute;
  typePriority: EventTypePriority;
  entityId: string;    // job or attempt identifier used for tie-break
  sortKey: string;     // "MMMM:P:entityId" — zero-padded minute, priority, entityId
  kind: string;
  payload: unknown;
}

// Canonical evidence bundle — no wall-clock timestamp so identical inputs
// produce identical JSON across runs.
interface EvidenceBundle {
  scenarioId: string;
  runs: JobRunRecord[];
  slots: KeySlot[];
  trace: TraceEntry[];
  eventLog: EventLogEntry[];
}
```

All records are plain objects. No class instances cross module boundaries. `ArtifactReadRecord.readMinute` is written once and the returned object is frozen immediately; nothing in the engine mutates it after creation.

---

## 4. Deterministic Event Engine

### 4.1 Per-minute phase model

Each integer minute is processed in three sequential phases. All events in Phase 1 complete before any event in Phase 2 begins; Phase 2 completes before Phase 3 begins. Within a phase, events are ordered by entity ID (lexicographic ascending, case-sensitive).

| Phase | typePriority | Events processed | Store state seen by reads |
|---|---|---|---|
| **1 — Completion** | 1 | Finish running jobs; run dedup; accepted outputs enter the store immediately; suppressed outputs do not | N/A — no reads in Phase 1 |
| **2 — Admission & WaitEnd** | 2 (Admission), 3 (WaitEnd) | Start new jobs and resolve eligible blocked jobs; evaluate all reads | Includes outputs accepted in Phase 1 of this minute |
| **3 — Deadline expiry** | 4 | Expire still-unresolved wait-policy deadlines | Not applicable |

**Key visibility rule:** an output artifact becomes visible to reads only when its producer's Completion event is processed (Phase 1). A suppressed output — one whose dedup check failed — is never added to the store and is never visible to any read, in this minute or any later minute.

**Key lifecycle rule:** reads are evaluated at Admission (Phase 2), not at Completion. By the time a job is admitted, Phase 1 of the same minute has already run, so any artifact published this minute is already in the store and readable.

### 4.2 Job lifecycle

| Moment | Minute | Phase | What happens |
|---|---|---|---|
| Any job's scheduled start reached | `scheduledStart` | Phase 2 — Admission | `classifyRead` called at `readMinute = scheduledStart` for each required input. If all required inputs are Fresh → job enters Running immediately (reads recorded, Completion enqueued at `scheduledStart + runDuration`). If any required input is not Fresh and job has a Wait Policy → job enters Blocked (`waitStart = scheduledStart`, BlockedWait trace). If no Wait Policy and input is not Fresh → job enters Running with whatever state the read returned (Stale/Unknown/Missing). |
| Running job finishes | `actualStart + runDuration` | Phase 1 — Completion | `completionMinute` set; dedup run; if accepted, `store.add()` called immediately; Suppression trace emitted if suppressed. |
| Artifact becomes available; blocked job wakes | `T_pub` or later | Phase 2 — WaitEnd | Freshness gate checked first (§4.6). If not Fresh → remain Blocked. If Fresh → timing gate checked. If timing passes → Admitted (reads recorded, Completion enqueued). If timing fails → DeadlineMissed. |
| Deadline minute arrives, job still Blocked | `deadline` | Phase 3 — DeadlineMiss | `completionStatus = DeadlineMissed`; `missReason = ArtifactNeverPublished`; trace emitted. Only fires if the job is still in Blocked state (resolution guard). |

**Completion is enqueued exactly once, upon the event that moves the job into Running state.** For jobs that admit at their scheduled start this is the Admission event. For jobs that admit via WaitEnd this is the WaitEnd event. No other path enqueues Completion.

**Wait-policy job at scheduled start:** even a job with a Wait Policy first checks whether its required data is already Fresh at `scheduledStart`. If it is, the job starts immediately without waiting — no BlockedWait trace is emitted and no WaitEnd is ever needed. The Wait Policy is a willingness to wait, not a mandate to wait.

### 4.3 Clock model and queue build

The simulator builds a sorted event queue from the declared scenario configuration, then processes events in `sortKey` order.

```
buildQueue(scenario) → EventQueueEntry[]
  for each declared job:
    enqueue Admission at scheduledStart, typePriority = 2
    // Completion is NOT enqueued here. It is enqueued exactly once when the
    // job enters Running state (at the Admission or WaitEnd event that admits it).

  for each declared job with a waitPolicy:
    enqueue DeadlineMiss at deadline, typePriority = 4  (tentative guard)
    // WaitEnd events are enqueued dynamically when store.add() fires.

sort by (minute ASC, typePriority ASC, entityId ASC [lexicographic, case-sensitive])
```

If two entries share the same `(minute, typePriority, entityId)` triplet the engine signals a configuration error and halts without committing any output (AC-031).

### 4.4 Tie-break sort key

Each entry carries a `sortKey` string of the form:

```
"${minute.toString().padStart(4,'0')}:${typePriority}:${entityId}"
```

This is the sole comparator (AC-030). `tie-break.ts` exports a pure `sortKey()` builder and a `compareEntries()` function with no side effects.

### 4.5 Event loop

Run state values: `Scheduled` (not yet reached), `Running` (admitted, Completion pending), `Blocked` (waiting for artifact), `Resolved` (Completion processed or DeadlineMissed).

```
simulate(scenario) → SimulationResult:
  validate all declared minutes in [0, 1439] (AC-043)
  initialise ArtifactStore, KeySlotMap, TraceLog, RunMap
  build and sort EventQueue

  for each event in EventQueue (in sortKey order):

    // Event-specific guards — each event kind fires only for the correct run state.
    // Violations are skipped silently (they are artefacts of tentative queue entries).
    Admission:   skip unless run.state = Scheduled
    WaitEnd:     skip unless run.state = Blocked
    DeadlineMiss: skip unless run.state = Blocked
    Completion:  skip unless run.state = Running

    switch event.kind:

      // ── PHASE 1 ─────────────────────────────────────────────────────────
      Completion →
          set completionMinute = actualStart + runDuration
          set run.state = Resolved
          set completionStatus = Success
          if job has output:
            result = dedup.commit(slot, attemptId, completionMinute, deduplicationEnabled)
            if result is 'accepted':  store.add(artifact)   // visible immediately in Phase 1
            if result is 'suppressed': emit Suppression trace; artifact NOT added to store

      // ── PHASE 2 ─────────────────────────────────────────────────────────
      Admission →
          // Check whether required inputs are Fresh at scheduledStart.
          // This applies to ALL jobs, including those with a Wait Policy.
          freshAtStart = all inputs classify as Fresh when readMinute = scheduledStart

          if freshAtStart OR job has no waitPolicy:
              // Admit immediately.
              evaluate reads: for each input, call classifyRead(store, ..., readMinute=scheduledStart)
              record reads on JobRunRecord (frozen); derive inputFreshnessStatus (AC-012)
              set actualStart = scheduledStart
              set run.state = Running
              enqueue Completion at actualStart + runDuration, typePriority = 1  // exactly once

          else:  // job has waitPolicy AND data is not Fresh at scheduledStart
              set completionStatus = Blocked; set waitStart = scheduledStart
              set run.state = Blocked
              emit BlockedWait trace entry
              // No Completion enqueued. WaitEnd will enqueue it on admission.

      WaitEnd →
          see §4.6 — admission gate
          if admitted:
              // Reads and Completion are set inside §4.6 on the admitted path.
              set run.state = Running
          if rejected:
              set run.state = Resolved
              emit DeadlineMiss trace with missReason

      // ── PHASE 3 ─────────────────────────────────────────────────────────
      DeadlineMiss (tentative guard — fires only when run.state = Blocked) →
          set run.state = Resolved
          set completionStatus = DeadlineMissed
          set missReason = ArtifactNeverPublished
          emit DeadlineMiss trace entry

  return SimulationResult (snapshot; immutable after return)
```

**WaitEnd coalescing:** when `store.add()` fires after a Completion in Phase 1, it enqueues a WaitEnd in Phase 2 of the same minute for each blocked job whose Wait Policy key and window match. If multiple publications in the same minute match the same blocked job, only one WaitEnd is enqueued for that job for that minute. The coalescing is keyed on `(jobId, minute)`.

### 4.6 Admission gate for waiting jobs (AC-019)

When a WaitEnd event fires for job J (guard: `run.state = Blocked`) with artifact available at minute `T_pub`:

```
effectiveStart = max(J.scheduledStart, T_pub)

// Step 1 — data freshness gate (checked first, before timing)
readState = classifyRead(store, key, requiredWindow,
                         readMinute = effectiveStart, ...)
if readState ≠ 'Fresh':
    // Artifact arrived but is not usable (Stale, Unknown, or Missing from effectiveStart).
    // Do NOT classify as a cutoff miss — the job remains Blocked waiting for Fresh data.
    // If this WaitEnd fires at the deadline minute, Phase 3 will handle the expiry.
    → remain Blocked; no state change

// Step 2 — timing gate (only reached when data is Fresh)
if effectiveStart > J.waitPolicy.deadline:
    → DeadlineMissed; missReason = ArtifactNeverPublished

else if effectiveStart + J.runDuration > J.waitPolicy.deadline:
    → DeadlineMissed; missReason = CompletionWouldExceedCutoff

else:
    // Both gates pass — admit the job.
    evaluate reads: for each input, call classifyRead(store, ..., readMinute=effectiveStart)
    record reads (frozen); derive inputFreshnessStatus
    set actualStart = effectiveStart; set waitEnd = T_pub
    // Completion is enqueued here — exactly once.
    enqueue Completion at actualStart + J.runDuration, typePriority = 1
    → Admitted (run.state = Running set by caller)
```

**Arrivals processed before expiry at the inclusive cutoff:** at the deadline minute, Phase 2 (WaitEnd, typePriority=3) runs before Phase 3 (DeadlineMiss, typePriority=4). If a Fresh artifact arrives at the deadline minute and the timing gate passes, the job is admitted in Phase 2. The tentative DeadlineMiss event in Phase 3 then fires against `run.state = Running` and is skipped by the guard — the job resolves once, as an admission.

**Non-Fresh arrival at the deadline:** if an artifact arrives at the deadline minute but is Stale or Unknown, Step 1 leaves the job Blocked. The Phase 3 DeadlineMiss guard then fires against `run.state = Blocked` and records `ArtifactNeverPublished`. The non-Fresh arrival is never classified as `CompletionWouldExceedCutoff`; that reason is reserved for a Fresh artifact that arrives too late to fit before the cutoff.

The case `T_pub = deadline` with `runDuration > 0` and a Fresh artifact fails at Step 2 (timing) with `CompletionWouldExceedCutoff`, covering the 08:15-publish, 2-min-duration boundary (AC-055 second paragraph).

### 4.7 Read-state classifier

`classifier.ts` exports a single pure function:

```
classifyRead(
  store: ArtifactStore,
  key: string,
  requiredWindow: number,
  readMinute: Minute,
  scheduledPublishMinute: Minute | undefined,
  fallbackEnabled: boolean,
  maxArtifactAge: number,
): ArtifactReadRecord
```

It applies AC-006's priority order exactly: **Fresh → Stale → Unknown → Missing**.

`readMinute` is set to the admission minute of the job (the minute the job starts execution). For non-waiting jobs this equals `scheduledStart`. For waiting jobs it equals `effectiveStart`. Because Phase 1 Completions run before Phase 2 Admissions in the same minute, any artifact whose producer completed this minute is already in the store when `classifyRead` is called.

**Fresh** (AC-002): artifact at exact window, `producerValid = true`, `0 ≤ age ≤ maxArtifactAge`.

**Stale** (AC-003):
- Arm (a): `fallbackEnabled = true`, prior-window artifact exists at the highest valid window below required, `producerValid = true`, `age ≥ 0`, no artifact at required window.
- Arm (b): artifact at exact required window, `producerValid = true`, `age > maxArtifactAge`.

**When fallback is disabled** (`fallbackEnabled = false`) and there is a prior-window artifact but no valid same-window artifact, arm (a) does not match. Evaluation continues to Unknown (if `scheduledPublishMinute > readMinute`) or Missing. Every read still receives a total state; no path through `classifyRead` exits without assigning one.

**Unknown** (AC-004):
- Arm (a): no artifact at required window, `scheduledPublishMinute > readMinute`.
- Arm (b): artifact at required window, `producerValid = false`.

**Missing** (AC-005): no artifact at any window and no scheduled publish minute in the future.

The returned `ArtifactReadRecord` is frozen immediately after construction. `readMinute` cannot change after that.

---

## 5. ArtifactStore

`store.ts` exports an `ArtifactStore` class:

```
add(record: ArtifactRecord): void
get(key, windowIndex): ArtifactRecord | undefined
getBestBelow(key, windowIndex): ArtifactRecord | undefined  — highest valid window < required
getAll(key): ArtifactRecord[]
onAdd(listener: (record: ArtifactRecord) => void): void
```

Internally a `Map<string, ArtifactRecord[]>` keyed by logical output key. `add()` appends and fires registered listeners. `getBestBelow` returns the artifact at the highest window index strictly below `windowIndex` where `producerValid = true`, or `undefined` if none. Read records copy field values out of `ArtifactRecord` at classify time, not references, so later `add()` calls cannot affect earlier reads.

---

## 6. Deduplication Guard

`dedup.ts` maintains a `Map<slotId, KeySlot>` where `slotId = "${key}::${windowIndex}"`.

```
commit(slotId, attemptId, minute, deduplicationEnabled): 'accepted' | 'suppressed'
```

- `deduplicationEnabled = false`: always accepted; both `attemptCount` and `effectCount` increment.
- `deduplicationEnabled = true`, no prior accepted effect: accepted; `acceptedEffectId` set.
- `deduplicationEnabled = true`, prior accepted effect present: suppressed; `SuppressedAttemptRecord` appended; `attemptCount` increments, `effectCount` does not.

`attemptCount` increments before the suppression check in all cases (AC-034). The `minute` argument is the **Completion minute** of the attempt, not the Admission minute.

---

## 7. Tracer

`tracer.ts` holds an append-only `TraceEntry[]`. It exports:

```
appendTrace(log: TraceEntry[], entry: TraceEntry): void
```

`appendTrace` pushes a new entry and never edits or removes an existing one. The `detail` field is a plain object constructed at call time from scalar values copied off live records — it contains no object references that could be mutated later (AC-026).

Trace entries are generated in phase order. Within the same minute, Phase 1 entries are appended before Phase 2 entries, which are appended before Phase 3 entries. Within a phase, entity ID order (lexicographic ascending) determines the append sequence, consistent with the event-loop processing order.

| Phase | Trace kind | When emitted |
|---|---|---|
| Phase 1 — Completion | `Suppression` | At the Completion event when `dedup.commit()` returns `'suppressed'`; `detail` includes the accepted effect ID and the suppression reason. |
| Phase 2 — Admission | `StaleRead` | At the Admission event when `classifyRead` returns `Stale`; `detail` includes the planned Collector run ID from the scenario config. |
| Phase 2 — Admission | `BlockedWait` | At the Admission event when a waiting job has no Fresh artifact yet; records `waitStart`. |
| Phase 2 — WaitEnd | `DeadlineMiss` | When the WaitEnd admission gate rejects the job (`CompletionWouldExceedCutoff`); `detail.missReason = 'CompletionWouldExceedCutoff'`. |
| Phase 3 — DeadlineMiss | `DeadlineMiss` | When the tentative DeadlineMiss fires for a still-unresolved job; `detail.missReason = 'ArtifactNeverPublished'`. |

---

## 8. Four Demo Fixtures and Their Expected Outputs

Each fixture is a plain TypeScript object conforming to `ScenarioConfig`. The expected output is an inline `SimulationResult` object used as the test oracle. All collectors start at 08:00 (minute 480) and finish at their declared publish minute. All scenarios use a single `runDuration` per job; `WaitPolicy` carries no separate duration.

### 8.1 CH-01 — Fresh artifact, immutable read evidence

```
Scenario config:
  maxArtifactAge: 60
  fallbackEnabled: false
  deduplicationEnabled: true

  collector-w1:
    scheduledStart = 480 (08:00)
    runDuration    = 4
    output: key="data", windowIndex=1
    → publishes at completionMinute = 480 + 4 = 484 (08:04)

  report-w1:
    scheduledStart = 486 (08:06)
    runDuration    = 2
    inputs: [{ key="data", requiredWindow=1 }]

Expected:
  collector-w1 run:
    actualStart=480, completionMinute=484, completionStatus=Success

  report-w1 read record (at Admission minute 486):
    state=Fresh, readMinute=486, publishMinute=484, artifactAge=2

  report-w1 run:
    actualStart=486, completionMinute=488
    completionStatus=Success, inputFreshnessStatus=Fresh

  Immutability assertion: read record fields at minute 489 (after completion)
  are identical to those recorded at minute 486.
```

### 8.2 CH-02 — Stale fallback, no retroactive relabelling

```
Scenario config:
  maxArtifactAge: 60
  fallbackEnabled: true        (Report-level flag)
  deduplicationEnabled: true

  Preloaded artifact (W0, before simulation starts):
    key="data", windowIndex=0, publishMinute=460, producerValid=true

  collector-w1:
    scheduledStart = 480 (08:00)
    runDuration    = 12
    scheduledPublishMinute for key="data" window=1: 492
    → publishes at completionMinute = 480 + 12 = 492 (08:12)

  report-w1:
    scheduledStart = 486 (08:06)
    runDuration    = 2
    inputs: [{ key="data", requiredWindow=1 }]
    fallbackEnabled = true

Expected at Admission minute 486 (before collector publishes):
  report-w1 read record:
    state=Stale, actualWindowIndex=0, publishMinute=460, artifactAge=26

  report-w1 run:
    actualStart=486, completionMinute=488
    completionStatus=Success, inputFreshnessStatus=Stale

After collector-w1 Completion at minute 492:
  report-w1 read record: state still=Stale (immutability; AC-048)
  report-w1 completionStatus: still=Success (AC-050)

Trace:
  StaleRead at eventMinute=486, reportId=report-w1,
  detail: { requiredWindow:1, fallbackWindow:0, plannedCollectorId:"collector-w1" }
```

### 8.3 CH-03 — Wait Policy, three sub-cases

Three fixture variants share this base. All collectors start at 480 (08:00). The report runs for 2 minutes; the same `runDuration=2` feeds both execution timing and the admission gate.

```
Base config:
  maxArtifactAge: 60
  fallbackEnabled: false
  deduplicationEnabled: true

  report-w1:
    scheduledStart = 486 (08:06)
    runDuration    = 2
    inputs: [{ key="data", requiredWindow=1 }]
    waitPolicy: { key="data", requiredWindow=1, deadline=495 }
```

**CH-03a — late arrival, admitted (happy path):**
```
  collector-w1: scheduledStart=480, runDuration=12 → Completion at 492

  Minute 486, Phase 2: Admission for report-w1.
    classifyRead at readMinute=486: no W1 artifact; scheduledPublishMinute=492 > 486
    → state=Unknown. Data is not Fresh. Wait Policy present → enter Blocked.
    waitStart=486. BlockedWait trace emitted.

  Minute 492, Phase 1: collector-w1 Completion fires; dedup accepted; store.add() called.
  Minute 492, Phase 2: WaitEnd fires for report-w1 (guard: Blocked ✓).
    effectiveStart = max(486, 492) = 492
    Step 1 — freshness: classifyRead at readMinute=492 → state=Fresh ✓ (proceed to timing)
    Step 2 — timing: 492 ≤ 495 ✓; 492+2=494 ≤ 495 ✓ → Admitted
    reads recorded; Completion enqueued at 494.

  report-w1 run:
    actualStart=492, completionMinute=494 (08:14)
    waitStart=486, waitEnd=492, waitOutcome=ArtifactArrived
    completionStatus=Success, inputFreshnessStatus=Fresh
```

**CH-03b — artifact never published, deadline miss:**
```
  No collector declared (or collector declared but fails without publishing).

  At minute 495: tentative DeadlineMiss fires (job not yet resolved)
  report-w1 run:
    completionStatus=DeadlineMissed, waitOutcome=DeadlineMissed
    missReason=ArtifactNeverPublished
  Trace: DeadlineMiss at eventMinute=495, detail.missReason=ArtifactNeverPublished
```

**CH-03c — publishes at deadline, duration overflows Finish Cutoff:**
```
  collector-w1: scheduledStart=480, runDuration=15 → Completion at 495

  Minute 495, Phase 1: collector-w1 Completion fires; dedup accepted; store.add() called.
  Minute 495, Phase 2: WaitEnd fires for report-w1 (guard: Blocked ✓; arrivals before expiry).
    effectiveStart = max(486, 495) = 495
    Step 1 — freshness: classifyRead at readMinute=495 → state=Fresh ✓ (proceed to timing)
    Step 2 — timing: 495 ≤ 495 ✓; 495+2=497 > 495 ✗ → DeadlineMissed
    missReason = CompletionWouldExceedCutoff; run.state = Resolved
  Minute 495, Phase 3: tentative DeadlineMiss fires; guard: run.state = Resolved → skipped.

  report-w1 run:
    completionStatus=DeadlineMissed, missReason=CompletionWouldExceedCutoff
  Trace: DeadlineMiss at eventMinute=495, detail.missReason=CompletionWouldExceedCutoff
```

### 8.4 CH-04 — Output deduplication

```
Scenario config — deduplication enabled variant:
  deduplicationEnabled: true

  attempt-1: scheduledStart=486, runDuration=1, output: key="result", windowIndex=1
  attempt-2: scheduledStart=486, runDuration=1, output: key="result", windowIndex=1

Both jobs are admitted at minute 486, Phase 2 (Admission, typePriority=2).
Tie-break at admission: "attempt-1" < "attempt-2" → both admitted; both enqueue Completion at 487.

At minute 487, Phase 1 (Completion, typePriority=1):
  "attempt-1" < "attempt-2" → attempt-1 Completion processed first.
  attempt-1 dedup.commit() → accepted; store.add() called; acceptedEffectId = "attempt-1".
  attempt-2 dedup.commit() → suppressed (slot already has accepted effect);
    SuppressedAttemptRecord.suppressedAtMinute = 487; artifact NOT added to store.
  Suppression trace emitted for attempt-2 during Phase 1 at minute 487.

Expected (dedup enabled):
  slot key="result" window=1:
    attemptCount=2, effectCount=1, acceptedEffectId="attempt-1"
  attempt-2 run: suppressed record with reason="duplicate-output-key"
  Display: attempt-2 labelled Suppressed, showing acceptedEffectId="attempt-1"

Scenario config — deduplication disabled variant:
  deduplicationEnabled: false  (same jobs)

Expected (dedup disabled):
  slot: attemptCount=2, effectCount=2
  Both runs: completionStatus=Success
```

---

## 9. Test Strategy

Tests live in `src/tests/`. The test runner is Vitest in `--run` mode (single execution, no watch). No external services or file I/O are needed; every test imports fixtures and calls `simulate()` or the relevant pure function directly.

### 9.1 Unit tests

| File | Covers |
|---|---|
| `classifier.test.ts` | All five classifier branches; edge cases listed in §9.3. |
| `tie-break.test.ts` | `sortKey()` output for all four `typePriority` values; comparator ordering for same-minute cross-type events; config-error detection for identical triplets. |
| `dedup.test.ts` | `commit()`: first attempt accepted; second suppressed when dedup enabled; both accepted when disabled; `attemptCount` increments before suppression check; `suppressedAtMinute` equals Completion minute. |
| `evidence.test.ts` | Canonical bundle is deterministic: identical inputs → identical JSON; no timestamp field present. |
| `simulator.test.ts` | Same-minute Phase-1-visible-to-Phase-2 reads; exactly one Completion per admitted run; suppressed output absent from store. |

### 9.2 Scenario integration tests

Each test calls `simulate(fixture)` and asserts the full `SimulationResult` against an inline expected object.

| File | Asserts |
|---|---|
| `ch01.test.ts` | `artifactAge=2`; `completionMinute=488`; read record fields unchanged after completion; artifact published at `480+4=484` not at admission. |
| `ch02.test.ts` | Stale state at minute 486; `actualWindowIndex=0`; read state unchanged after minute 492 publication; trace `plannedCollectorId` field; `completionStatus=Success` with `inputFreshnessStatus=Stale`. |
| `ch03.test.ts` | CH-03a: `effectiveStart=492`, `completionMinute=494`, `waitOutcome=ArtifactArrived`. CH-03b: `missReason=ArtifactNeverPublished` at minute 495. CH-03c: `missReason=CompletionWouldExceedCutoff`; job not started despite artifact arriving at deadline. |
| `ch04.test.ts` | Dedup enabled: `attemptCount=2, effectCount=1`; `suppressedAtMinute=487`; suppressed record references correct `acceptedEffectId`. Dedup disabled: `effectCount=2`. Tie-break determines which attempt is first. |

### 9.3 Regression cases

These cases are added as named test cases within the files above or in the relevant unit test file. Each is independent and targets a specific invariant introduced or changed during requirements iteration.

| Regression | Test location | Invariant checked |
|---|---|---|
| Publish-at-finish, not admission | `ch01.test.ts` | `eventLog` contains a Completion event at minute 484, not 480; artifact is in store after minute 484 Phase 1, not before. |
| Same-minute Phase-1 output visible to Phase-2 reads | `simulator.test.ts` | A job with `scheduledStart=487` and an input key reads a Fresh artifact whose producer's Completion is also at minute 487 Phase 1; the read record carries `state=Fresh` and `readMinute=487`. |
| Suppressed output not visible in store | `ch04.test.ts` | After dedup with enabled flag, only one artifact record exists for the slot; the suppressed attempt's artifact is absent from the store. |
| Exactly one Completion per admitted run | `simulator.test.ts` | `eventLog.filter(e => e.kind === 'Completion' && e.entityId === jobId).length === 1` for every admitted job. No duplicate Completion events. |
| No Completion in queue at build time | `simulator.test.ts` | `eventQueue` after `buildQueue` contains no Completion entries; all Completions are enqueued during event processing. |
| Wait-policy job admits immediately if Fresh at scheduledStart | `ch03.test.ts` | Variant with artifact preloaded at the required window before scheduledStart; at minute 486 Admission, `classifyRead` returns Fresh → job enters Running directly; no BlockedWait trace; `actualStart = 486`. |
| Non-Fresh arrival keeps job Blocked, not DeadlineMissed | `ch03.test.ts` | Stale artifact (W0) arrives at minute 492 for a job waiting for W1 with `fallbackEnabled=false`; Step 1 returns non-Fresh → job stays Blocked; no DeadlineMissed at minute 492; DeadlineMiss fires at minute 495 with `missReason=ArtifactNeverPublished`. |
| Fallback-disabled with prior-window artifact | `classifier.test.ts` | `classifyRead` with `fallbackEnabled=false`, W0 in store, no W1 artifact, `scheduledPublishMinute=492 > readMinute=486` → `state=Unknown`, not `Stale`. |
| Fallback-disabled, no future publish | `classifier.test.ts` | Same as above but `scheduledPublishMinute=480 < readMinute=486` → `state=Missing`, not `Stale`. |
| Invalid producer → Unknown not Stale | `classifier.test.ts` | Artifact at exact required window, `producerValid=false`, age within max → `state=Unknown` (AC-004b), not `Fresh` or `Stale`. |
| `effectiveStart` when artifact arrives before schedule | `ch03.test.ts` | Artifact at T_pub=483 (before scheduledStart=486); at WaitEnd `effectiveStart = max(486,483) = 486`; `readMinute=486` on the read record; job does not start before its scheduled minute (AC-018). |
| `CompletionWouldExceedCutoff` boundary | `ch03.test.ts` (CH-03c) | Artifact at T_pub=495, `runDuration=2`; Step 1 Fresh ✓; Step 2: `495+2=497 > 495`; `missReason=CompletionWouldExceedCutoff`; no Running state reached. |
| Arrivals processed before expiry at inclusive cutoff | `ch03.test.ts` (CH-03c) | WaitEnd at minute 495 is processed in Phase 2 before DeadlineMiss Phase 3; the run resolves as `CompletionWouldExceedCutoff` not `ArtifactNeverPublished`. |
| Single deadline resolution | `ch03.test.ts` | Exactly one DeadlineMiss trace entry per job per run, regardless of how many WaitEnd and DeadlineMiss events are in the queue for the same minute. |
| `attemptCount` increments before suppression check | `dedup.test.ts` | After a suppressed commit, `attemptCount=2` and `effectCount=1` on the slot. |
| Canonical evidence is timestamp-free | `evidence.test.ts` | `JSON.stringify(buildEvidence(r1)) === JSON.stringify(buildEvidence(r2))` when `r1` and `r2` are produced from identical fixture configs; no `generatedAt` field present. |
| `suppressedAtMinute` = Completion not Admission | `ch04.test.ts` | Suppressed attempt's `suppressedAtMinute` equals `scheduledStart + runDuration = 487`, not `486`. |
| Trace order derived from phases | `ch04.test.ts` | Suppression trace entry (Phase 1) appears before any StaleRead or BlockedWait trace entries (Phase 2) at the same minute in `result.trace`. |

### 9.4 Property invariants (checked inline in each scenario test)

- Every `ArtifactReadRecord` carries exactly one `state` value.
- `readMinute` is identical before and after any Completion event that fires after the read.
- `attemptCount ≥ effectCount` always.
- `effectCount ≤ 1` per slot when dedup is enabled.
- Every `TraceEntry.eventMinute` equals the minute at which the triggering event fires, never a later minute.
- For every minute M, all Completion events in the event log at minute M precede all Admission and WaitEnd events at minute M, which precede all DeadlineMiss events at minute M.
- No artifact record in the store was produced by a suppressed attempt.

---

## 10. Evidence Export

`evidence.ts` exports:

```ts
buildEvidence(result: SimulationResult): EvidenceBundle
```

`EvidenceBundle` is a plain JSON-serialisable object with no wall-clock timestamp:

```json
{
  "scenarioId": "CH-01",
  "runs": [...],
  "slots": [...],
  "trace": [...],
  "eventLog": [...]
}
```

There is no `generatedAt` field. Two calls to `buildEvidence` on results from identical fixture configs produce identical JSON. This makes the bundle usable as a regression baseline: a reviewer can compare stored JSON against a fresh run with a simple string equality check without stripping fields first.

Each `eventLog` entry includes its `sortKey` field so a reviewer can verify tie-break ordering without re-running the simulation (AC-030).

`buildEvidence` does not mutate `result`; it creates a deep clone of the relevant fields.

The UI provides a "Copy JSON" button that calls `JSON.stringify(buildEvidence(result), null, 2)` and writes to the clipboard. No file download, server POST, or `localStorage` write occurs.

---

## 11. Static Build

### 11.1 Build tool

The project uses **esbuild** to compile and bundle `src/ui/app.ts` and all its transitive imports into a single `dist/bundle.js`. esbuild requires no configuration file for this use case; all options are passed on the command line or via a minimal `build.mjs` script:

```
esbuild src/ui/app.ts \
  --bundle \
  --platform=browser \
  --target=es2020 \
  --outfile=dist/bundle.js \
  --format=esm
```

TypeScript type-checking (`tsc --noEmit`) is a separate step run before the bundle step. esbuild does not type-check; it only transpiles.

### 11.2 Output

```
dist/
  bundle.js    — single ES module; all src/ code included; no dynamic imports
```

`index.html` loads it as:

```html
<script type="module" src="dist/bundle.js"></script>
```

No CDN, no import maps, no additional assets. The page works by opening `index.html` directly in a browser (`file://` protocol) or serving from any static file server.

### 11.3 Test runner

Vitest runs directly against the TypeScript source via its built-in esbuild transform — no separate compile step needed for tests.

### 11.4 Build artifacts

`dist/bundle.js` is the only generated file. It may be committed alongside source or regenerated locally. The simulation logic, fixtures, and test files have no dependency on `dist/`; they are always imported from `src/`.

---

## 12. Browser UI

The UI is a single `index.html` with an inline `<style>` block. It loads `dist/bundle.js` as an ES module.

### 12.1 Layout (three panels)

```
┌──────────────────────────────────────────┐
│  Scenario  [CH-01 ▾]  [Run]  [Copy JSON] │
├─────────────────────────┬────────────────┤
│  Timeline               │  Trace Log     │
│  (event log table)      │  (trace list)  │
├─────────────────────────┴────────────────┤
│  Job Runs table                          │
│  completionStatus │ freshness │ reads    │
│  wait fields │ missReason                │
├──────────────────────────────────────────┤
│  Key Slots table                         │
│  attemptCount │ effectCount │ suppressed │
└──────────────────────────────────────────┘
```

### 12.2 Timeline table columns

`Minute` | `SortKey` | `Kind` | `Entity` | `Detail`

One row per `EventLogEntry`, rendered in `sortKey` order. The `SortKey` column makes tie-break ordering directly auditable.

### 12.3 Job Runs table columns

`Job` | `Status` | `Freshness` | `ActualStart` | `Completion` | `WaitOutcome` | `MissReason` | `Reads`

`Status` and `Freshness` are colour-coded badges using a `data-state` attribute driven by CSS attribute selectors — no inline styles, no JavaScript-based colouring. `Reads` is an expandable row: clicking toggles a nested table showing all `ArtifactReadRecord` fields including `state`, `readMinute`, `artifactAge` (labelled "Age at Read"), and `publishMinute`.

### 12.4 Key Slots table columns

`Key` | `Window` | `AttemptCount` | `EffectCount` | `AcceptedEffect` | `SuppressedAttempts`

`AttemptCount` and `EffectCount` are always rendered as separate labelled cells; they are never merged or summed (AC-035).

### 12.5 Rendering constraints

- `render.ts` is a pure function: `render(result: SimulationResult, container: HTMLElement): void`. It clears `container` and rebuilds the DOM. No global state.
- No framework dependency. Standard DOM APIs only.
- All badge labels use the exact string values from `ReadState`, `CompletionStatus`, and `WaitOutcome` so test assertions can match displayed text directly.

---

## 13. Data Flow Summary

```
ScenarioConfig (fixture)
       │
       ▼
  simulate()   ← engine/simulator.ts
       │  uses: store, classifier, scheduler, tie-break, dedup, tracer
       ▼
  SimulationResult  (immutable snapshot)
       │
       ├──► render()        → DOM (browser UI)
       │
       └──► buildEvidence() → EvidenceBundle (no timestamp)
                                   │
                                   └──► JSON.stringify → clipboard
```

No data flows backward from the UI or the evidence export into the simulation result.

---

## 14. Decisions and Rationale

| Decision | Rationale |
|---|---|
| Three explicit same-minute phases (Completion → Admission/WaitEnd → DeadlineMiss) | Makes visibility deterministic: Phase 1 outputs are always readable by Phase 2 reads in the same minute, with no ambiguity about whether a same-minute producer has run yet. |
| Suppressed outputs never enter the store | A suppressed attempt has no causal effect; treating its artifact as invisible is the only semantics consistent with `effectCount` counting accepted effects only. |
| Reads at Admission, not Completion | A job reads its inputs when it starts; recording reads at a later point would create a gap between what the job saw and what the record says it saw. |
| Completion enqueued exactly once, upon entering Running | Enqueueing at build time would require pre-computing admission outcomes before any events fire, which is impossible for waiting jobs. Enqueueing at the Admission or WaitEnd event that admits the job is the only correct single point of truth. |
| Event-specific guards (Admission/Scheduled, WaitEnd/Blocked, DeadlineMiss/Blocked, Completion/Running) | A flat "skip if resolved" guard would incorrectly skip Completions for running jobs if the resolved check is too broad, or would fail to skip stale WaitEnd events after a job is already admitted. Per-event guards make each transition explicit and independently verifiable. |
| Wait-policy job checks Fresh at scheduledStart before entering Blocked | A Wait Policy is a willingness to wait, not a mandate. If the data is already Fresh when the job reaches its scheduled start, waiting is unnecessary and would delay the result. Checking first avoids spurious BlockedWait traces and incorrect wait-start records. |
| Freshness gate checked before timing gate in §4.6 | A non-Fresh arrival (Stale, Unknown) should not be classified as `CompletionWouldExceedCutoff` — that reason implies the data was usable but arrived too late to fit. Checking freshness first keeps the two failure modes distinct and accurate. |
| WaitEnd coalescing keyed on `(jobId, minute)` | Multiple publications in the same minute matching the same waiting job must not produce duplicate WaitEnd events, which would trigger duplicate read evaluations and potentially duplicate Completion enqueues. |
| Wait gate checks freshness at `effectiveStart` via `classifyRead` | A waiting job must not be admitted on data that is Stale or Unknown from its own perspective; re-using the same classifier ensures the freshness rules are applied consistently and not duplicated. |
| Trace order derived from phase order | Phase 1 Suppression entries appear before Phase 2 read entries at the same minute, consistent with the causal order of events. This makes the trace directly verifiable against the event log without cross-referencing. |
| Output published at Completion, not Admission | Admission is when a job starts reading; the artifact it produces is not yet available until it finishes. Separating these events gives the correct causal order and prevents a job from reading its own output. |
| Single `runDuration` on `JobDefinition`; none on `WaitPolicy` | One authoritative value eliminates the risk of the two diverging silently. The admission gate and the execution timing both use `JobDefinition.runDuration`. |
| Collector fixtures start at 08:00, finish at 08:04 or 08:12 | Matches the EXECUTION-LEDGER canonical examples exactly and makes `artifactAge` arithmetic unambiguous. |
| Fallback-disabled path always assigns Unknown or Missing | Guarantees every read has a total state from the four-value enum. No path through `classifyRead` exits without assigning a state. |
| Tentative DeadlineMiss inert after WaitEnd resolution | The resolution guard (`state = Resolved`) handles this; no explicit cancellation needed. The DeadlineMiss event fires only if the job is still unresolved at the deadline minute. |
| `EvidenceBundle` has no `generatedAt` | Deterministic output enables string-equality regression testing. A caller that needs a dated copy can append `generatedAt` after `buildEvidence` returns. |
| esbuild for static bundle | Zero-config for this use case; sub-second build; no plugin needed; produces a single file compatible with `file://` opening. |
| Event queue built from declared config, not stepped minute-by-minute | O(E log E) in declared events, not O(1440). Keeps the engine fast and test fixtures easy to reason about. |
| `sortKey` stored on `EventLogEntry` | Gives reviewers a human-readable, re-checkable ordering field without re-running the sort (AC-030). |
| Dedup commit at Completion minute | The artifact is only published at finish; the dedup check must occur at the same moment to maintain causal consistency. `suppressedAtMinute` is therefore the Completion minute. |
| Trace entries use scalar snapshots in `detail` | Prevents aliasing: a later mutation to any live record cannot silently change what an earlier trace entry records (AC-026). |

---

## 15. Out of Scope

- Persistent storage, server API, authentication.
- Real-time clock or scheduler.
- Scenario editing UI (scenarios are code-only fixtures at this stage).
- CSS theming beyond minimal badge styling.
- MCP, Crew companion, or Power integration (tracked separately in EXECUTION-LEDGER.md).
