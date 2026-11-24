# Implementation Tasks

## Feature: Scenario-Artifact Contracts

Requirements: `requirements.md` — AC-001 through AC-060  
Design: `design.md`

Tasks are ordered so each depends only on what precedes it. The browser UI is deferred until engine tests pass independently.

---

## Task 1: Project scaffold and types

**Goal:** Create the TypeScript project structure, configuration, and all shared types. No logic yet.

- [ ] 1.1 Create `package.json` with dependencies: `typescript`, `vitest`, `esbuild`. Scripts: `test` runs `vitest --run`, `typecheck` runs `tsc --noEmit`, `build` runs esbuild (see §11.1 of design).
- [ ] 1.2 Create `tsconfig.json`: `strict: true`, `moduleResolution: bundler`, `target: ES2020`, `outDir: dist`, `noEmit: true` (type-check only; esbuild handles emit).
- [ ] 1.3 Create `src/engine/types.ts` with all interfaces and type aliases from design §3: `Minute`, `ReadState`, `CompletionStatus`, `InputFreshnessStatus`, `WaitOutcome`, `MissReason`, `EventTypePriority`, `RunState` (`'Scheduled' | 'Running' | 'Blocked' | 'Resolved'`), `ArtifactRecord`, `WaitPolicy`, `JobDefinition`, `ArtifactReadRecord`, `JobRunRecord`, `KeySlot`, `SuppressedAttemptRecord`, `TraceEntry`, `SimulationResult`, `EventLogEntry`, `EvidenceBundle`, `ScenarioConfig`.
- [ ] 1.4 Verify `tsc --noEmit` passes with zero errors.

**Acceptance:** `npx tsc --noEmit` exits 0. No logic files exist yet.

---

## Task 2: Tie-break module

**Goal:** Implement and test the deterministic sort key and comparator.

- [ ] 2.1 Create `src/engine/tie-break.ts`:
  - `sortKey(minute, typePriority, entityId)` → `"MMMM:P:entityId"` (zero-padded minute, single-digit priority, entityId).
  - `compareEntries(a, b)` → negative/zero/positive; uses `sortKey` as the sole comparator; returns a configuration error (thrown) if two entries have equal `(minute, typePriority, entityId)`.
- [ ] 2.2 Create `src/tests/tie-break.test.ts`:
  - `sortKey` produces correct format for all four `typePriority` values.
  - `compareEntries` orders Phase 1 before Phase 2 before Phase 3 within the same minute.
  - Within a phase, lexicographically earlier `entityId` sorts first.
  - `compareEntries` throws on identical triplet (AC-031).

**Acceptance:** `vitest --run tie-break` exits 0, all cases pass.

---

## Task 3: ArtifactStore

**Goal:** Implement and test the append-only artifact store.

- [ ] 3.1 Create `src/engine/store.ts`:
  - `ArtifactStore` class with `add`, `get`, `getBestBelow`, `getAll`, `onAdd` as specified in design §5.
  - `add` appends and fires all registered listeners.
  - `getBestBelow` returns the artifact at the highest valid window index strictly below the required window where `producerValid = true`, or `undefined`.
  - No mutation of existing entries.
- [ ] 3.2 Create tests within `src/tests/simulator.test.ts` (store section):
  - `add` then `get` returns the added record.
  - `getBestBelow` returns correct prior-window record.
  - `getBestBelow` ignores records with `producerValid = false`.
  - `onAdd` listener fires on each `add` call.
  - Two `add` calls for different windows both retrievable independently.

**Acceptance:** store tests pass.

---

## Task 4: Read-state classifier

**Goal:** Implement and test the pure read-state classification function.

- [ ] 4.1 Create `src/engine/classifier.ts` implementing `classifyRead` per design §4.7:
  - Priority order: Fresh → Stale → Unknown → Missing.
  - Fresh (AC-002): exact window, `producerValid = true`, `0 ≤ age ≤ maxArtifactAge`.
  - Stale arm (a) (AC-003): `fallbackEnabled = true`, prior-window artifact, `producerValid = true`, `age ≥ 0`, no artifact at required window.
  - Stale arm (b) (AC-003): exact window, `producerValid = true`, `age > maxArtifactAge`.
  - Unknown arm (a) (AC-004): no artifact at required window, `scheduledPublishMinute > readMinute`.
  - Unknown arm (b) (AC-004): artifact at required window, `producerValid = false`.
  - Missing (AC-005): no artifact at any window, no future scheduled publish.
  - Returns a frozen `ArtifactReadRecord`.
- [ ] 4.2 Create `src/tests/classifier.test.ts`:
  - Fresh: exact window, valid producer, age within max → Fresh.
  - Fresh edge: `age = 0`, `age = maxArtifactAge` → Fresh; `age = maxArtifactAge + 1` → Stale arm (b).
  - Stale arm (a): fallback enabled, prior window, valid producer, no W1 → Stale.
  - Stale arm (a): fallback disabled, prior window, no W1, future publish → Unknown (not Stale). *(Regression: fallback-disabled with prior-window artifact)*
  - Stale arm (a): fallback disabled, prior window, no W1, no future publish → Missing (not Stale). *(Regression: fallback-disabled, no future publish)*
  - Stale arm (b): exact window, valid producer, over-age → Stale.
  - Unknown arm (b): exact window, `producerValid = false`, age within max → Unknown. *(Regression: invalid producer)*
  - Missing: no artifact, no future publish → Missing.
  - Returned record is frozen (`Object.isFrozen`).
  - `readMinute` on returned record matches the argument.

**Acceptance:** `vitest --run classifier` exits 0, all cases pass.

---

## Task 5: Deduplication guard

**Goal:** Implement and test the per-slot deduplication guard.

- [ ] 5.1 Create `src/engine/dedup.ts` implementing `DedupGuard` with `commit` per design §6:
  - `attemptCount` increments before the suppression check.
  - `deduplicationEnabled = false`: always accepted; `effectCount` increments.
  - `deduplicationEnabled = true`, first commit: accepted; `acceptedEffectId` set.
  - `deduplicationEnabled = true`, subsequent commit: suppressed; `SuppressedAttemptRecord` appended.
- [ ] 5.2 Create `src/tests/dedup.test.ts`:
  - First commit accepted regardless of flag.
  - Second commit suppressed when dedup enabled; `attemptCount = 2`, `effectCount = 1`. *(Regression: attemptCount before suppression check)*
  - Second commit accepted when dedup disabled; `attemptCount = 2`, `effectCount = 2`.
  - `suppressedAtMinute` equals the Completion minute passed to `commit`. *(Regression: suppressedAtMinute = Completion)*
  - Suppressed record carries `reason = 'duplicate-output-key'` and correct `acceptedEffectId`.

**Acceptance:** `vitest --run dedup` exits 0, all cases pass.

---

## Task 6: Tracer

**Goal:** Implement the append-only trace log.

- [ ] 6.1 Create `src/engine/tracer.ts` with `appendTrace(log, entry)`:
  - Pushes to the array; never modifies existing entries.
  - `detail` field must be a plain object snapshot (no live references).

No separate test file needed; tracer correctness is verified through integration tests in Tasks 8–11.

---

## Task 7: Simulator — event engine

**Goal:** Implement the core `simulate()` function with the three-phase event loop.

- [ ] 7.1 Create `src/engine/scheduler.ts`:
  - `buildQueue(scenario)` → sorted `EventQueueEntry[]`.
  - Enqueues only `Admission` (all jobs) and `DeadlineMiss` (wait-policy jobs) at build time. No Completions. *(AC-031; design §4.3)*
  - Deduplicates on `(minute, typePriority, entityId)` — throws configuration error on collision.
- [ ] 7.2 Create `src/engine/simulator.ts` implementing `simulate(scenario): SimulationResult`:
  - Validates all minutes in [0, 1439] (AC-043).
  - Event-specific guards: `Admission` → `Scheduled` only; `WaitEnd` → `Blocked` only; `DeadlineMiss` → `Blocked` only; `Completion` → `Running` only. *(design §4.5)*
  - **Admission handler**: calls `classifyRead` at `scheduledStart` for all required inputs. If all Fresh (or no wait policy): enter Running, record reads, enqueue Completion exactly once. If any input not Fresh and wait policy present: enter Blocked, emit BlockedWait trace, no Completion enqueued. *(design §4.2, §4.5)*
  - **WaitEnd handler**: runs §4.6 gate — freshness check first, then timing check. On admission: record reads at `effectiveStart`, enqueue Completion exactly once, enter Running. On rejection: enter Resolved, emit DeadlineMiss trace. On non-Fresh (remain Blocked): no state change.
  - **Completion handler**: set `completionMinute`, enter Resolved, run dedup, call `store.add()` only on accepted result, emit Suppression trace on suppressed. *(design §4.5)*
  - **DeadlineMiss handler**: enter Resolved, `missReason = ArtifactNeverPublished`, emit DeadlineMiss trace.
  - WaitEnd coalescing: `store.onAdd` enqueues at most one WaitEnd per `(jobId, minute)`. *(design §4.5)*
  - Returns immutable `SimulationResult` snapshot.
- [ ] 7.3 Create `src/tests/simulator.test.ts` — engine-level invariants:
  - `buildQueue` output contains no Completion entries. *(Regression: no Completion at build time)*
  - Exactly one Completion per admitted run in the event log. *(Regression: exactly one Completion)*
  - Completion event at minute M precedes Admission events at minute M in `eventLog`. *(Phase order invariant)*
  - Suppressed output absent from store after dedup. *(Regression: suppressed output not visible)*
  - Same-minute Phase-1 output visible to Phase-2 reads: producer `scheduledStart=487`, consumer `scheduledStart=487` → consumer reads Fresh. *(Regression: same-minute visibility)*
  - Wait-policy job with Fresh data at scheduledStart admits directly; no BlockedWait trace. *(Regression: immediate admission)*
  - Non-Fresh artifact arrival keeps job Blocked; DeadlineMiss fires at deadline with `ArtifactNeverPublished`. *(Regression: non-Fresh keeps Blocked)*

**Acceptance:** `vitest --run simulator` exits 0, all invariant tests pass.

---

## Task 8: CH-01 fixture and test

**Goal:** Implement and verify the fresh-artifact, immutable-read scenario.

- [ ] 8.1 Create `src/fixtures/ch01.ts` with `ScenarioConfig`:
  - `collector-w1`: `scheduledStart=480`, `runDuration=4`, output `key="data"`, `windowIndex=1`.
  - `report-w1`: `scheduledStart=486`, `runDuration=2`, inputs `[{key:"data", requiredWindow:1}]`.
  - `maxArtifactAge=60`, `fallbackEnabled=false`, `deduplicationEnabled=true`.
- [ ] 8.2 Create `src/tests/ch01.test.ts`:
  - `collector-w1`: `actualStart=480`, `completionMinute=484`, `completionStatus=Success`.
  - `report-w1` read record: `state=Fresh`, `readMinute=486`, `publishMinute=484`, `artifactAge=2`. *(AC-044)*
  - `report-w1` run: `completionMinute=488`, `completionStatus=Success`, `inputFreshnessStatus=Fresh`. *(AC-045)*
  - Immutability: read record object identity and field values unchanged after simulation completes. *(AC-045, AC-016)*
  - Display field: `artifactAge` is 2. *(AC-046)*
  - Completion event at minute 484 (not 480) in `eventLog`. *(Regression: publish-at-finish)*
  - No Completion event at minute 480 in `eventLog`.

**Acceptance:** `vitest --run ch01` exits 0, all assertions pass.

---

## Task 9: CH-02 fixture and test

**Goal:** Implement and verify the stale-fallback, no-retroactive-relabelling scenario.

- [ ] 9.1 Create `src/fixtures/ch02.ts`:
  - Preloaded artifact: `key="data"`, `windowIndex=0`, `publishMinute=460`, `producerValid=true`.
  - `collector-w1`: `scheduledStart=480`, `runDuration=12`, output `key="data"`, `windowIndex=1`, `scheduledPublishMinutes: {"data:1": 492}`.
  - `report-w1`: `scheduledStart=486`, `runDuration=2`, inputs `[{key:"data", requiredWindow:1}]`, `fallbackEnabled=true`.
  - `maxArtifactAge=60`, `deduplicationEnabled=true`.
- [ ] 9.2 Create `src/tests/ch02.test.ts`:
  - `report-w1` read record at minute 486: `state=Stale`, `actualWindowIndex=0`, `publishMinute=460`, `artifactAge=26`. *(AC-047)*
  - `report-w1` run: `completionMinute=488`, `completionStatus=Success`, `inputFreshnessStatus=Stale`. *(AC-050)*
  - After collector Completion at minute 492, read record `state` is still `Stale`. *(AC-048)*
  - Trace entry: `StaleRead` at `eventMinute=486`, `detail.plannedCollectorId="collector-w1"`, `detail.fallbackWindow=0`. *(AC-049)*
  - `completionStatus=Success` and `inputFreshnessStatus=Stale` coexist on the same run record. *(AC-050)*

**Acceptance:** `vitest --run ch02` exits 0, all assertions pass.

---

## Task 10: CH-03 fixture and test

**Goal:** Implement and verify the wait-policy scenario (three sub-cases plus two regressions).

- [ ] 10.1 Create `src/fixtures/ch03.ts` exporting three `ScenarioConfig` objects: `ch03a`, `ch03b`, `ch03c`, plus two regression variants: `ch03_immediateAdmit` (Fresh at scheduledStart) and `ch03_nonFreshArrival` (non-Fresh artifact arrives at wakeup minute).

  Base config for all:
  - `report-w1`: `scheduledStart=486`, `runDuration=2`, `waitPolicy: {key:"data", requiredWindow:1, deadline:495}`.
  - `maxArtifactAge=60`, `fallbackEnabled=false`, `deduplicationEnabled=true`.

  Variants:
  - `ch03a`: `collector-w1` with `scheduledStart=480`, `runDuration=12`.
  - `ch03b`: no collector declared.
  - `ch03c`: `collector-w1` with `scheduledStart=480`, `runDuration=15`.
  - `ch03_immediateAdmit`: preloaded artifact `key="data"` W1 at `publishMinute=480`, `producerValid=true`; no collector needed.
  - `ch03_nonFreshArrival`: collector publishes W0 (not W1) at minute 492; `fallbackEnabled=false`.

- [ ] 10.2 Create `src/tests/ch03.test.ts`:
  - **CH-03a**: `waitStart=486`, `waitEnd=492`, `actualStart=492`, `completionMinute=494`, `waitOutcome=ArtifactArrived`, `completionStatus=Success`, `inputFreshnessStatus=Fresh`. *(AC-051, AC-052, AC-053)*
  - **CH-03b**: `completionStatus=DeadlineMissed`, `missReason=ArtifactNeverPublished`. *(AC-054, AC-055)*
  - **CH-03c**: `completionStatus=DeadlineMissed`, `missReason=CompletionWouldExceedCutoff`. *(AC-055)*
  - **CH-03c**: WaitEnd resolved at minute 495 Phase 2 before DeadlineMiss Phase 3; trace carries `CompletionWouldExceedCutoff`, not `ArtifactNeverPublished`. *(Regression: arrivals before expiry)*
  - **CH-03_immediateAdmit**: at Admission minute 486, `classifyRead` returns Fresh; `actualStart=486`, no BlockedWait trace. *(Regression: immediate admission)*
  - **CH-03_nonFreshArrival**: W0 arrival at minute 492 leaves job Blocked; DeadlineMiss at minute 495 carries `ArtifactNeverPublished`. *(Regression: non-Fresh keeps Blocked)*
  - `effectiveStart` = `max(486, T_pub)` for each sub-case. *(AC-019)*

**Acceptance:** `vitest --run ch03` exits 0, all assertions pass.

---

## Task 11: CH-04 fixture and test

**Goal:** Implement and verify the deduplication scenario (two variants).

- [ ] 11.1 Create `src/fixtures/ch04.ts` exporting `ch04Enabled` and `ch04Disabled`:
  - Both: `attempt-1` and `attempt-2`, `scheduledStart=486`, `runDuration=1`, output `key="result"`, `windowIndex=1`.
  - `ch04Enabled`: `deduplicationEnabled=true`.
  - `ch04Disabled`: `deduplicationEnabled=false`.
- [ ] 11.2 Create `src/tests/ch04.test.ts`:
  - **Enabled**: `attemptCount=2`, `effectCount=1`, `acceptedEffectId="attempt-1"`. *(AC-056, AC-057)*
  - **Enabled**: suppressed record `suppressedAtMinute=487`, `reason="duplicate-output-key"`, `acceptedEffectId="attempt-1"`. *(AC-033)*
  - **Enabled**: only one artifact record in store for `key="result"` W1. *(Regression: suppressed output not in store)*
  - **Disabled**: `attemptCount=2`, `effectCount=2`. *(AC-058)*
  - Tie-break: "attempt-1" < "attempt-2" → attempt-1 is the accepted effect. *(AC-060)*
  - Suppression trace entry Phase 1 before any Phase 2 trace at minute 487. *(Regression: trace order)*

**Acceptance:** `vitest --run ch04` exits 0, all assertions pass.

---

## Task 12: Evidence export

**Goal:** Implement and test the canonical timestamp-free evidence bundle.

- [ ] 12.1 Create `src/export/evidence.ts` implementing `buildEvidence(result): EvidenceBundle`:
  - Deep-clones `runs`, `slots`, `trace`, `eventLog` from `SimulationResult`.
  - No `generatedAt` field in the returned object.
  - Does not mutate the input.
- [ ] 12.2 Create `src/tests/evidence.test.ts`:
  - Two calls on the same result produce identical `JSON.stringify` output. *(Regression: timestamp-free)*
  - Two calls on results from identical fixture configs produce identical JSON. *(AC-042)*
  - No `generatedAt` key in the bundle.
  - `eventLog` entries include `sortKey` field. *(AC-030)*

**Acceptance:** `vitest --run evidence` exits 0, all assertions pass.

---

## Task 13: Full regression run

**Goal:** Run all tests together and confirm no cross-module interactions break any case.

- [ ] 13.1 Run `vitest --run` (all tests). Every test must pass.
- [ ] 13.2 Run `tsc --noEmit`. Zero type errors.
- [ ] 13.3 Confirm regression coverage: check each row in design §9.3 has a corresponding passing test assertion.

**Acceptance:** `vitest --run` exits 0. `tsc --noEmit` exits 0. All §9.3 regressions traceable to a passing test.

---

## Task 14: Browser UI (deferred — after Task 13 passes)

**Goal:** Implement the minimal browser UI described in design §12.

This task is blocked on Task 13 passing independently. It is listed here to establish ordering but must not be started until engine tests are verified.

- [ ] 14.1 Create `src/ui/render.ts` — pure `render(result, container)` function.
- [ ] 14.2 Create `src/ui/app.ts` — scenario selector, Run button, Copy JSON button.
- [ ] 14.3 Create `index.html` loading `dist/bundle.js`.
- [ ] 14.4 Run `tsc --noEmit` and esbuild bundle step; verify `dist/bundle.js` is produced.
- [ ] 14.5 Open `index.html` in browser; manually verify all four scenarios render correctly.

**Acceptance:** All four CH-01–CH-04 scenarios render without errors. Bundle produced at `dist/bundle.js`.
