# Requirements Document

## Introduction

Clockwork Haunt is a browser-only synthetic job-scheduling visualiser. It models logical data windows, job collectors, report jobs, and artifact publication using integer-minute timestamps on a single bounded logical clock. No real infrastructure or external services are involved.

This feature — **Scenario-Artifact Contracts** — defines the precise rules governing how jobs read artifacts, how artifact states are classified, how jobs wait for late artifacts, how simultaneous events are ordered deterministically, and how duplicate output effects are suppressed. The four canonical acceptance scenarios (CH-01 through CH-04) are fully traceable to individual acceptance criteria in this document.

---

## Glossary

- **Window (W)**: A labelled logical time slot on the bounded clock, identified by a non-negative integer index (e.g., W0, W1, W2). Jobs are associated with a specific window they are expected to consume or produce.
- **Artifact**: An immutable data record published to a named logical output key at a specific integer-minute timestamp. An artifact carries: its logical output key, the window it represents, the minute it was published, and the job attempt that produced it.
- **Collector**: A job that produces an artifact for a given window by publishing to a logical output key.
- **Report**: A job that consumes one or more artifacts as inputs and produces an output artifact or a result record.
- **Fresh**: An artifact read state indicating that the artifact exists for the exact window the job requires, was published by a successful job attempt, and has a non-negative age (readMinute − publishMinute) that is less than or equal to the configured maximum artifact age. Fresh is mutually exclusive with Stale, Missing, and Unknown.
- **Stale**: An artifact read state indicating any of the following conditions: (a) an artifact exists for the requested logical output key but belongs to an earlier window (W−n, n ≥ 1) than the window the job requires and no artifact for the required window exists; or (b) an artifact exists for the exact required window but its age (`readMinute − publishMinute`) exceeds the configured maximum artifact age. Stale is mutually exclusive with Fresh, Missing, and Unknown.
- **Blocked**: A job run state indicating that execution has not started because a required artifact has not yet been published and the job's declared deadline has not passed. Blocked is a `completionStatus` value, not an artifact read state; a blocked job has not yet performed a read.
- **Missing**: An artifact read state indicating that no artifact exists in the artifact store for the requested logical output key at any window index, AND no scheduled publish minute for that key and required window is strictly in the future at the time of the read. Missing is mutually exclusive with Stale, Fresh, and Unknown.
- **Unknown**: An artifact read state indicating that no usable artifact can be confirmed for the requested logical output key at the required window index — either because no artifact record exists and the scheduled publish minute is strictly in the future, or because an artifact record exists for the required window but was not produced by a valid successful attempt. Unknown is mutually exclusive with Stale, Fresh, and Missing. Unknown transitions to Missing if the scheduled publish minute passes without a valid publication.
- **Wait Policy**: A declaration on a job specifying the logical output key it requires, the exact window it requires, and a deadline (integer minute) up to which the job is willing to wait for that artifact before the run is recorded as deadline-missed.
- **Finish Cutoff**: The inclusive deadline minute by which a job's execution must complete (last minute at which completion is acceptable). For a job admitted at start minute S with run duration D, it completes at S + D. Admission is only permitted if S + D ≤ Finish Cutoff. The Finish Cutoff is the same value as the Wait Policy deadline minute.
- **Logical Output Key**: A string identifier naming a specific artifact slot (e.g., `collector.window-report`). Multiple windows can publish artifacts under the same key; the key plus window index together uniquely identify a slot.
- **Attempt**: One execution run of a job. A single job may have multiple attempts (e.g., due to replay). Each attempt has a stable, unique identifier.
- **Effect**: An accepted change to the artifact store resulting from one successful attempt. An effect is recorded at most once per logical output key per window, regardless of how many attempts commit to that slot.
- **Suppressed Attempt**: An attempt that completed successfully and committed an artifact to a logical output key already occupied by an accepted effect. The attempt is recorded as suppressed with an explicit reason; it does not add a second effect.
- **Tie-break**: The deterministic ordering rule applied when two or more events are assigned the same integer minute. Rule: publications become visible before admissions at equal priority; then stable job/attempt identifier order (lexicographic ascending) breaks remaining ties.
- **Synthetic Clock**: The bounded single-day integer-minute clock used by the simulator. All timestamps are integers in the range [0, 1439] representing minutes from midnight (e.g., 480 = 08:00). No real wall-clock time is used.

---

## Requirements

### Requirement 1: Artifact State Classification

**User Story:** As a simulation reviewer, I want every artifact read to carry an explicit state label drawn from a mutually exclusive set, so that I can distinguish exactly what a job read and why, without ambiguity.

#### Acceptance Criteria

1. **AC-001** — THE Simulator SHALL assign exactly one of four read states to every artifact read record: `Fresh`, `Stale`, `Missing`, or `Unknown`. These states are mutually exclusive; no read record may carry more than one.

2. **AC-002** — WHEN a job reads a logical output key and an artifact exists in the artifact store for that key at the exact required window index, and that artifact was published by a successful job attempt whose result is recorded as valid, and the value of `readMinute − publishMinute` is greater than or equal to 0 and less than or equal to the configured maximum artifact age, THE Simulator SHALL assign the state `Fresh` to that read record.

3. **AC-003** — WHEN a job reads a logical output key and either (a) prior-window fallback is enabled in the scenario configuration and an artifact record exists in the artifact store for that key at a window index strictly less than the required window index and that artifact was published by a successful attempt whose result is recorded as valid and the value of `readMinute − publishMinute` for that artifact is greater than or equal to 0 and no artifact for the required window index exists, or (b) an artifact record exists for the exact required window index and that artifact was published by a successful attempt whose result is recorded as valid and the value of `readMinute − publishMinute` exceeds the configured maximum artifact age, THE Simulator SHALL assign the state `Stale` to that read record.

4. **AC-004** — IF any of the following conditions holds, THEN THE Simulator SHALL assign the state `Unknown` to that read record:
   (a) no artifact record exists in the artifact store for a logical output key at the required window index AND the artifact's scheduled publish minute for that key and window index is strictly greater than the current clock minute; or
   (b) an artifact record exists for the exact required window index but was not produced by a successful attempt whose result is recorded as valid.

5. **AC-005** — IF no artifact record exists in the artifact store for a logical output key at any window index AND no scheduled publish minute for that key and required window is strictly in the future at the time of the read, THEN THE Simulator SHALL assign the state `Missing` to that read record.

6. **AC-006** — THE Simulator SHALL evaluate read-state assignment in the following fixed priority order: `Fresh` first, then `Stale`, then `Unknown`, then `Missing`; the first matching state is assigned and evaluation stops. *(Stale precedes Unknown so that an available prior-window fallback artifact is surfaced before an unresolvable future-publish window; this is required for CH-02 where W−1 exists and W has a future scheduled publish minute.)*

7. **AC-007** — THE Simulator SHALL record each artifact read with: the logical output key, the required window index, the actual artifact's window index (or null if the state is `Missing` or `Unknown`), the state label, the publish minute of the artifact (or null if Missing/Unknown), and the integer clock minute of the read (`readMinute`).

---

### Requirement 2: Job Completion Status Independence from Input Freshness

**User Story:** As a simulation reviewer, I want to see job success/failure status and input artifact freshness recorded as separate fields, so that I can verify that a job can complete successfully while having consumed stale or fallback data.

#### Acceptance Criteria

8. **AC-008** — THE Simulator SHALL record job run outcomes with two independent fields: `completionStatus` (values: `Success`, `Failure`, `Blocked`, `DeadlineMissed`) and `inputFreshnessStatus` (values: `Fresh`, `Stale`, `Missing`, `Unknown`). `completionStatus` reflects whether execution completed; `inputFreshnessStatus` reflects the worst-case read state across all inputs consumed.

9. **AC-009** — WHEN a job completes with `completionStatus = Success` and all required input artifacts carry state `Stale`, THE Simulator SHALL record `inputFreshnessStatus = Stale` without altering the `completionStatus`.

10. **AC-010** — WHEN a job completes with `completionStatus = Success` and all required input artifacts carry state `Missing`, THE Simulator SHALL record `inputFreshnessStatus = Missing` without altering the `completionStatus`.

11. **AC-011** — WHEN a job completes with `completionStatus = Success` and all required input artifacts carry state `Stale` or `Missing`, THE Simulator SHALL not implicitly treat the run as a failure.

12. **AC-012** — WHEN a job has multiple required inputs, THE Simulator SHALL derive `inputFreshnessStatus` as the worst-case state across all inputs using the precedence order `Missing` > `Unknown` > `Stale` > `Fresh`, and SHALL store that derived value in the `inputFreshnessStatus` field of the job run record.

13. **AC-013** — THE Display SHALL render `completionStatus` and `inputFreshnessStatus` as visually distinct, labelled fields on every job run record. *(Traces CH-01 and CH-02.)*

---

### Requirement 3: Immutable Read Evidence

**User Story:** As a simulation reviewer, I want the artifact state recorded at read time to be permanently fixed, so that a later publication of a matching artifact cannot retroactively change what a job is shown to have read.

#### Acceptance Criteria

14. **AC-014** — WHEN an artifact is published to a logical output key after a job has already recorded a read of that key, THE Simulator SHALL not alter the state label or artifact reference on the earlier read record.

15. **AC-015** — WHEN an artifact for window W is published at minute T2 and a job had already read that key at minute T1 < T2 and recorded state `Missing` or `Stale`, THE Simulator SHALL retain the original state on the read record and SHALL NOT relabel it to `Fresh`.

16. **AC-016** — THE Simulator SHALL attach a `readMinute` value to every artifact read record, equal to the simulation clock minute at which the read is performed. This value SHALL NOT change after the read record is written, and no subsequent event (including a publish event for the same key) may alter it. *(Traces CH-01 and CH-02.)*

---

### Requirement 4: Wait Policy and Blocking

**User Story:** As a simulation designer, I want to declare that a job is willing to wait for a required artifact up to a deadline, so that the simulator can model blocked waits, successful late-start runs, and deadline-missed outcomes explicitly.

#### Acceptance Criteria

17. **AC-017** — THE Simulator SHALL accept a Wait Policy declaration on a job specifying: logical output key, required window index, deadline (integer minute in the range [0, 1439]), and run duration (positive integer number of minutes). The deadline minute serves as the Finish Cutoff: a job is admitted only if its projected completion minute (`startMinute + runDuration`) is less than or equal to the Finish Cutoff. The Finish Cutoff is inclusive.

18. **AC-018** — WHEN a job has a Wait Policy and its scheduled start minute has been reached and the required artifact has not yet been published and the current clock minute is strictly less than the declared deadline minute, THE Simulator SHALL record the job's `completionStatus` as `Blocked` and SHALL NOT start the job's execution. No artifact read record is created for a blocked job. The Simulator SHALL NOT start a waiting job before its originally scheduled start minute even if the required artifact becomes available earlier.

19. **AC-019** — WHEN a required artifact is published at minute T_pub and the value of `max(scheduledStartMinute, T_pub)` is less than or equal to the job's declared deadline minute and the value of `max(scheduledStartMinute, T_pub) + runDuration` is less than or equal to the Finish Cutoff, THE Simulator SHALL admit the job: set `effectiveStart = max(scheduledStartMinute, T_pub)`, start execution at `effectiveStart`, record `waitStart` as the original scheduled start minute, `waitEnd` as T_pub, `actualStart` as `effectiveStart`, and `waitOutcome` as `ArtifactArrived`.

20. **AC-020** — THE Simulator SHALL record `completionStatus = DeadlineMissed` and SHALL NOT start the job's execution in either of the following cases:
    (a) the clock advances to the declared deadline minute and the required artifact has still not been published; or
    (b) the required artifact is published at minute T_pub where T_pub is less than or equal to the deadline minute but the value of T_pub + runDuration is strictly greater than the Finish Cutoff.
    In both cases the Simulator SHALL record the deadline minute in the run record. The transition fires at or as of the event minute, not after.

21. **AC-021** — WHEN a job's Wait Policy deadline is missed, THE Simulator SHALL record the miss reason in the run's trace entry using exactly the values defined in AC-055: `ArtifactNeverPublished` when the artifact was never published by the deadline minute, or `CompletionWouldExceedCutoff` when the artifact arrived at or before the deadline but `effectiveStart + runDuration` would exceed the Finish Cutoff.

22. **AC-022** — THE Simulator SHALL record `waitStart`, `waitEnd`, and `waitOutcome` (values: `ArtifactArrived`, `DeadlineMissed`) on every run that activates a Wait Policy.

23. **AC-023** — WHEN a job completes after a successful wait (artifact arrived and the job was admitted per AC-019), THE Simulator SHALL record `completionStatus = Success` and SHALL record `inputFreshnessStatus = Fresh` if and only if the conditions in AC-002 are satisfied for that artifact at the time of the read. *(Traces CH-03.)*

---

### Requirement 5: Trace Linking for Stale and Blocked Outcomes

**User Story:** As a simulation reviewer, I want to follow a chain of cause from a late or missing Collector publication to a Report's stale or blocked outcome, so that I can audit the dependency path without manual reconstruction.

#### Acceptance Criteria

24. **AC-024** — WHEN a Report records `inputFreshnessStatus = Stale`, THE Simulator SHALL generate a trace entry at that event time containing: the Report run identifier, the artifact key read, the simulation minute of the read, the stale artifact's window index and publish minute, and the planned Collector run identifier for the required window (as declared in the scenario configuration). This trace entry SHALL NOT modify any existing read record.

25. **AC-025** — WHEN a Report records `completionStatus = Blocked` or `completionStatus = DeadlineMissed`, THE Simulator SHALL generate a trace entry at that event time containing: the Report run identifier, the blocked input key, the simulation minute at which blocking was recorded or the deadline elapsed, and the planned Collector run identifier for the required window (or null if no Collector run was declared for that window in the configuration). This trace entry SHALL NOT modify any existing run or read record.

26. **AC-026** — THE Simulator SHALL generate trace entries at event time and SHALL NOT reconstruct or rewrite trace links after the fact. *(Traces CH-02 and CH-03.)*

---

### Requirement 6: Deterministic Tie-breaking

**User Story:** As a simulation designer, I want events that land in the same integer minute to be ordered by a stable deterministic rule, so that the simulator produces the same result every time given the same input.

#### Acceptance Criteria

27. **AC-027** — WHEN two or more events are assigned the same integer minute, THE Simulator SHALL order them using the following rule in priority order: (1) artifact publications are ordered before job admissions; (2) among events of the same type, stable lexicographic ascending order of job/attempt identifier breaks ties.

28. **AC-028** — THE Simulator SHALL apply the tie-break rule consistently across all event types including: artifact publications, job admissions, wait-end triggers, and deadline-missed recordings.

29. **AC-029** — WHEN the same synthetic input is provided to the Simulator on two separate runs, THE Simulator SHALL produce identical event orderings and identical output records on both runs.

30. **AC-030** — THE Simulator SHALL expose the applied tie-break ordering as a readable field on the event log so that reviewers can verify the ordering rule was applied correctly.

31. **AC-031** — IF two events have equal minute, equal event-type priority, and equal job/attempt identifier, THEN THE Simulator SHALL signal a configuration error rather than produce a non-deterministic ordering. *(Traces tie-break rule from EXECUTION-LEDGER.md.)*

---

### Requirement 7: Output Deduplication

**User Story:** As a simulation designer, I want replay attempts that commit to an already-occupied logical output key to be explicitly suppressed, so that the display distinguishes accepted effects from suppressed attempts and shows attempt count separately from effect count.

#### Acceptance Criteria

32. **AC-032** — WHEN deduplication is enabled in the simulation configuration AND a job attempt commits an artifact to a logical output key and window index that already has an accepted effect, THE Simulator SHALL record the attempt as `Suppressed` and SHALL NOT create a second effect.

33. **AC-033** — THE Simulator SHALL record on every suppressed attempt: the attempt identifier, the logical output key, the window index, the minute of the suppressed commit, the identifier of the previously accepted effect, and the suppression reason string `"duplicate-output-key"`.

34. **AC-034** — THE Simulator SHALL maintain an `attemptCount` field and an `effectCount` field on every logical output key slot. These fields SHALL be updated independently: `attemptCount` increments on every commit attempt; `effectCount` increments only when an attempt is accepted (not suppressed).

35. **AC-035** — THE Display SHALL render `attemptCount` and `effectCount` as labelled, visually distinct fields on the artifact slot record so that the two counts are never conflated.

36. **AC-036** — WHEN deduplication is disabled in the simulation configuration, THE Simulator SHALL accept all commit attempts and increment `effectCount` for each, so that reviewers can observe the two-effect outcome for comparison.

37. **AC-037** — WHEN deduplication is enabled, THE Simulator SHALL accept only the first commit ranked by the tie-break rule in AC-027 for a given logical output key and window index, and SHALL suppress all subsequent commits to that same key and window, recording each as described in AC-033. *(Traces CH-04.)*

---

### Requirement 8: Synthetic Bounded Clock

**User Story:** As a simulation designer, I want the simulator to operate entirely on a synthetic integer-minute clock with no dependency on real time or external sources, so that all scenarios are reproducible and self-contained.

#### Acceptance Criteria

38. **AC-038** — THE Simulator SHALL represent all timestamps as non-negative integers in the range [0, 1439], where each integer represents one minute from midnight (e.g., 480 = 08:00).

39. **AC-039** — THE Simulator SHALL accept all scenario inputs — job definitions, window indices, artifact publication minutes, deadlines, and wait policies — as explicit integer-minute values provided in a declarative configuration.

40. **AC-040** — THE Simulator SHALL not read or use any real wall-clock, system time, or external data source during scenario execution.

41. **AC-041** — THE Simulator SHALL advance the clock in discrete integer steps determined by the declared event minutes in the input, processing all events at each minute before advancing to the next.

42. **AC-042** — WHEN two separate simulator runs are given the same declarative configuration, THE Simulator SHALL produce byte-for-byte identical output records for all job runs, artifact reads, effects, suppressed attempts, and trace entries.

43. **AC-043** — THE Simulator SHALL enforce that all declared event minutes in a single scenario fall within a single logical day (minutes 0 through 1439 inclusive) and SHALL reject configurations that violate this bound.

---

### Requirement 9: CH-01 Scenario Coverage — Fresh Artifact, Completion Does Not Rewrite Read

**User Story:** As a simulation reviewer, I want to verify that a Report reading a fresh artifact at 08:06 and completing at 08:08 is recorded exactly as it ran, so that the read evidence at 08:06 is not affected by the completion event.

#### Acceptance Criteria

44. **AC-044** — WHEN the Collector publishes artifact for window W at minute 484 (08:04) via a successful attempt, and the Report reads that artifact at minute 486 (08:06), THE Simulator SHALL record the read event with `state = Fresh`, `readMinute = 486`, `publishMinute = 484`, and `artifactAge = readMinute − publishMinute = 2`.

45. **AC-045** — WHEN the Report completes at minute 488 (08:08), THE Simulator SHALL not alter the `readMinute`, `state`, or artifact age recorded at minute 486.

46. **AC-046** — WHEN a Report run record exists, THE Display SHALL present the `artifactAge` value in a field labelled "Age at Read" that reflects the value recorded at read time, regardless of the Report's completion minute.

---

### Requirement 10: CH-02 Scenario Coverage — Stale Fallback, No Retroactive Relabelling

**User Story:** As a simulation reviewer, I want to verify that a Report using a W−1 fallback artifact at 08:06 is permanently recorded as stale, even after the Collector later publishes the correct W artifact at 08:12.

#### Acceptance Criteria

47. **AC-047** — WHEN the Collector has not published an artifact for window W by minute 486 (08:06) and a preloaded W−1 artifact exists, THE Simulator SHALL record the Report's read with `state = Stale` and the W−1 artifact reference.

48. **AC-048** — WHEN the Collector publishes artifact for window W at minute 492 (08:12) and the Report had already completed at minute 488 (08:08) using the W−1 artifact, THE Simulator SHALL retain `state = Stale` on the original read record.

49. **AC-049** — WHEN the Simulator records a stale read for the Report, THE Simulator SHALL generate a trace entry at the minute of the stale read containing: the Report identifier, the read record identifier, `state = Stale`, the window identifier W for which no artifact was available, the read minute (486), the W−1 artifact's window identifier and publish minute, and the planned Collector run identifier for window W as declared in the scenario configuration. This trace entry SHALL NOT alter the read record.

50. **AC-050** — THE Simulator SHALL record `completionStatus = Success` and `inputFreshnessStatus = Stale` on the Report's run, confirming that success and staleness are independent. *(Traces CH-02.)*

---

### Requirement 11: CH-03 Scenario Coverage — Wait Policy, Blocking, and Deadline Miss

**User Story:** As a simulation reviewer, I want to verify that a Report declaring a wait policy for window W with deadline 08:15 blocks correctly, starts late when the artifact arrives, and is recorded as deadline-missed if the artifact never arrives.

#### Acceptance Criteria

51. **AC-051** — WHEN the Report declares a Wait Policy requiring window W with deadline minute 495 (08:15) and the Report's scheduled start minute 486 (08:06) is reached and no artifact for window W has been published, THE Simulator SHALL record `completionStatus = Blocked`, `waitStart = 486`, and SHALL NOT begin execution of the Report's processing steps.

52. **AC-052** — WHEN the Collector publishes artifact for window W at minute 492 (08:12) and 492 ≤ 495 (deadline) and 492 + 2 = 494 ≤ 495 (Finish Cutoff), THE Simulator SHALL admit the Report: start execution at minute 492, record `waitEnd = 492`, `waitOutcome = ArtifactArrived`, and complete the Report at minute 494 (08:14).

53. **AC-053** — WHEN the Report completes after a successful wait (admitted per AC-019), THE Simulator SHALL record `completionStatus = Success` and SHALL record `inputFreshnessStatus = Fresh` if and only if the conditions in AC-002 are satisfied for the artifact at the time of the read.

54. **AC-054** — WHEN the clock advances to minute 495 (08:15) and no artifact for window W has been published, THE Simulator SHALL transition the Report's run record to `completionStatus = DeadlineMissed`, `waitOutcome = DeadlineMissed`, and SHALL NOT start the Report's execution.

55. **AC-055** — WHEN `completionStatus = DeadlineMissed`, THE Simulator SHALL include a trace entry citing the missing or non-admissible Collector publication as the proximate cause, referencing the specific logical output key and window index, and the reason for the miss (`ArtifactNeverPublished` or `CompletionWouldExceedCutoff`). *(Traces CH-03.)*

    Additionally, WHEN the Collector publishes artifact for window W at minute 495 (08:15) and the Report's run duration is 2 minutes, the value 495 + 2 = 497 exceeds the Finish Cutoff of 495; THE Simulator SHALL record `completionStatus = DeadlineMissed` with reason `CompletionWouldExceedCutoff` and SHALL NOT start the Report's execution. This case is a miss even though the artifact arrived at the deadline minute.

---

### Requirement 12: CH-04 Scenario Coverage — Deduplication of Replayed Attempts

**User Story:** As a simulation reviewer, I want to verify that two successful attempts committing to the same logical output key produce one accepted effect and one suppressed attempt when deduplication is enabled, and two accepted effects when it is disabled.

#### Acceptance Criteria

56. **AC-056** — WHEN deduplication is enabled and two attempts commit to the same logical output key and window index, THE Simulator SHALL accept the first ordered attempt as an effect and record the second as `Suppressed` with reason `"duplicate-output-key"`.

57. **AC-057** — WHEN deduplication is enabled, THE Simulator SHALL record `attemptCount = 2` and `effectCount = 1` on the logical output key slot after both commits are processed.

58. **AC-058** — WHEN deduplication is disabled, THE Simulator SHALL accept both commits as effects and record `attemptCount = 2` and `effectCount = 2` on the slot.

59. **AC-059** — THE Display SHALL render both the accepted effect and the suppressed attempt in the event log, with the suppressed attempt clearly labelled `Suppressed` and showing the identifier of the accepted effect it duplicated.

60. **AC-060** — THE Simulator SHALL determine which attempt is "first" using the tie-break rule defined in AC-027 so that the deduplication outcome is fully deterministic. *(Traces CH-04.)*

---

## Scenario Traceability Index

| Scenario | Key Acceptance Criteria |
|----------|------------------------|
| CH-01 | AC-044, AC-045, AC-046, AC-002, AC-006, AC-014, AC-015, AC-016 |
| CH-02 | AC-047, AC-048, AC-049, AC-050, AC-003, AC-006, AC-014, AC-015, AC-016, AC-024, AC-025 |
| CH-03 | AC-051, AC-052, AC-053, AC-054, AC-055, AC-017, AC-018, AC-019, AC-020, AC-021, AC-022, AC-023 |
| CH-04 | AC-056, AC-057, AC-058, AC-059, AC-060, AC-032, AC-033, AC-034, AC-035, AC-036, AC-037 |
