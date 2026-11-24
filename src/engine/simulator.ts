import type {
  ScenarioConfig, SimulationResult, JobRunRecord,
  ArtifactRecord, TraceEntry, Minute, RunState,
} from './types.ts';
import { ArtifactStore } from './store.ts';
import { classifyRead, worstFreshness } from './classifier.ts';
import { DedupGuard } from './dedup.ts';
import { appendTrace } from './tracer.ts';
import { buildQueue, makeEntry, type QueueEntry } from './scheduler.ts';

interface RunMeta {
  record: JobRunRecord;
  state: RunState;
}

export function simulate(scenario: ScenarioConfig): SimulationResult {
  // ── Validate minute bounds (AC-043) ──────────────────────────────────────
  for (const job of scenario.jobs) {
    if (!Number.isInteger(job.scheduledStart) || job.scheduledStart < 0 || job.scheduledStart > 1439) {
      throw new Error(`Job "${job.id}" scheduledStart ${job.scheduledStart} out of [0,1439]`);
    }
    if (!Number.isInteger(job.runDuration) || job.runDuration <= 0) {
      throw new Error(`Job "${job.id}" runDuration must be a positive integer`);
    }
    const finMin = job.scheduledStart + job.runDuration;
    if (finMin > 1439) {
      throw new Error(`Job "${job.id}" completion minute ${finMin} exceeds 1439`);
    }
    if (job.waitPolicy) {
      if (!Number.isInteger(job.waitPolicy.deadline) || job.waitPolicy.deadline < job.scheduledStart || job.waitPolicy.deadline > 1439) {
        throw new Error(`Job "${job.id}" deadline ${job.waitPolicy.deadline} out of [0,1439]`);
      }
    }
  }

  // ── Initialise ───────────────────────────────────────────────────────────
  const store = new ArtifactStore();
  const dedup = new DedupGuard();
  const trace: TraceEntry[] = [];
  const eventLog: QueueEntry[] = [];
  const runs = new Map<string, RunMeta>();

  // Load preloaded artifacts before the simulation clock starts.
  for (const a of scenario.preloadedArtifacts ?? []) {
    store.add(a);
  }

  // Build the run map.
  for (const job of scenario.jobs) {
    runs.set(job.id, {
      state: 'Scheduled',
      record: {
        jobId: job.id,
        attemptId: job.id, // attempt ID equals job ID for single-attempt scenarios
        scheduledStart: job.scheduledStart,
        actualStart: null,
        completionMinute: null,
        completionStatus: 'Blocked', // placeholder; overwritten on admission
        inputFreshnessStatus: null,
        waitStart: null,
        waitEnd: null,
        waitOutcome: null,
        missReason: null,
        reads: [],
      },
    });
  }

  // Build the initial static queue.
  const queue: QueueEntry[] = buildQueue(scenario);

  // Set to coalesce WaitEnd events: (jobId, minute) → already enqueued?
  const waitEndCoalesced = new Set<string>();

  // The queue grows dynamically; we process by pointer.
  // We re-sort whenever a new entry is inserted (entries are few in test scenarios).
  let qi = 0;

  function insertAndSort(entry: QueueEntry): void {
    queue.push(entry);
    queue.sort((a, b) => {
      if (a.sortKey < b.sortKey) return -1;
      if (a.sortKey > b.sortKey) return 1;
      return 0;
    });
    // After re-sort, the pointer qi still points into the same relative position.
    // We recalculate qi to skip entries we've already processed (those with
    // sortKey < queue[qi_old].sortKey before insertion).
    // Simplest: qi stays at current position because newly inserted entries
    // at earlier positions would have been in the past — but we guard against
    // past-minute insertions by only inserting WaitEnd/Completion at current
    // or future minutes.
  }

  // Listen for store additions to enqueue WaitEnd events.
  store.onAdd((artifact: ArtifactRecord) => {
    for (const job of scenario.jobs) {
      if (!job.waitPolicy) continue;
      if (
        job.waitPolicy.key !== artifact.key ||
        job.waitPolicy.requiredWindow !== artifact.windowIndex
      ) continue;
      const meta = runs.get(job.id);
      if (!meta || meta.state !== 'Blocked') continue;

      // Coalesce: at most one WaitEnd per (jobId, artifact.publishMinute).
      const coalesceKey = `${job.id}:${artifact.publishMinute}`;
      if (waitEndCoalesced.has(coalesceKey)) continue;
      waitEndCoalesced.add(coalesceKey);

      const entry = makeEntry(
        artifact.publishMinute,
        3,
        job.id,
        'WaitEnd',
        { tPub: artifact.publishMinute },
        job.id,
      );
      insertAndSort(entry);
    }
  });

  // ── Event loop ────────────────────────────────────────────────────────────
  while (qi < queue.length) {
    const event = queue[qi++];
    const job = scenario.jobs.find((j) => j.id === event.jobId);
    if (!job) continue;
    const meta = runs.get(job.id)!;

    // Event-specific guards.
    if (event.kind === 'Admission' && meta.state !== 'Scheduled') continue;
    if (event.kind === 'WaitEnd' && meta.state !== 'Blocked') continue;
    if (event.kind === 'DeadlineMiss' && meta.state !== 'Blocked') continue;
    if (event.kind === 'Completion' && meta.state !== 'Running') continue;

    eventLog.push(event);

    switch (event.kind) {
      // ── PHASE 1: Completion ──────────────────────────────────────────────
      case 'Completion': {
        const completionMinute = meta.record.actualStart! + job.runDuration;
        meta.record.completionMinute = completionMinute;
        meta.record.completionStatus = 'Success';
        meta.state = 'Resolved';

        if (job.output) {
          const artifact: ArtifactRecord = {
            key: job.output.key,
            windowIndex: job.output.windowIndex,
            publishMinute: completionMinute,
            attemptId: job.id,
            producerValid: true,
          };
          const result = dedup.commit(
            job.output.key,
            job.output.windowIndex,
            job.id,
            completionMinute,
            job.deduplicationEnabled ?? true,
          );
          if (result === 'accepted') {
            store.add(artifact);
          } else {
            const slot = dedup.getOrCreate(job.output.key, job.output.windowIndex);
            appendTrace(trace, {
              eventMinute: completionMinute,
              kind: 'Suppression',
              reportId: job.id,
              detail: {
                attemptId: job.id,
                key: job.output.key,
                windowIndex: job.output.windowIndex,
                suppressedAtMinute: completionMinute,
                acceptedEffectId: slot.acceptedEffectId,
                reason: 'duplicate-output-key',
              },
            });
          }
        }
        break;
      }

      // ── PHASE 2: Admission ───────────────────────────────────────────────
      case 'Admission': {
        const scheduledStart = job.scheduledStart;

        // Evaluate ordinary inputs separately from the exact Wait Policy target.
        const preReads = job.inputs.map((inp) =>
          classifyRead({
            store,
            key: inp.key,
            requiredWindow: inp.requiredWindow,
            readMinute: scheduledStart,
            scheduledPublishMinute: job.scheduledPublishMinutes?.[`${inp.key}:${inp.requiredWindow}`],
            fallbackEnabled: job.fallbackEnabled ?? false,
            maxArtifactAge: scenario.maxArtifactAge,
            jobId: job.id,
            attemptId: job.id,
          }),
        );
        const wp = job.waitPolicy;
        const policyFresh = wp && classifyRead({
          store, key: wp.key, requiredWindow: wp.requiredWindow,
          readMinute: scheduledStart, scheduledPublishMinute: undefined,
          fallbackEnabled: false, maxArtifactAge: scenario.maxArtifactAge,
          jobId: job.id, attemptId: job.id,
        }).state === 'Fresh';

        if (wp && policyFresh && scheduledStart + job.runDuration > wp.deadline) {
          const missReason = 'CompletionWouldExceedCutoff';
          meta.record.completionStatus = 'DeadlineMissed';
          meta.record.waitOutcome = 'DeadlineMissed';
          meta.record.missReason = missReason;
          meta.state = 'Resolved';
          appendTrace(trace, {
            eventMinute: scheduledStart, kind: 'DeadlineMiss', reportId: job.id,
            detail: { missReason, key: wp.key, requiredWindow: wp.requiredWindow },
          });
          break;
        }

        if (policyFresh || !wp) {
          // Admit immediately.
          meta.record.reads = preReads;
          meta.record.inputFreshnessStatus = worstFreshness(preReads.map((r) => r.state));
          meta.record.actualStart = scheduledStart;
          meta.record.completionStatus = 'Success'; // tentative; confirmed at Completion
          meta.state = 'Running';

          // Emit StaleRead traces if any.
          for (const read of preReads) {
            if (read.state === 'Stale') {
              appendTrace(trace, {
                eventMinute: scheduledStart,
                kind: 'StaleRead',
                reportId: job.id,
                detail: {
                  key: read.key,
                  requiredWindow: read.requiredWindow,
                  fallbackWindow: read.actualWindowIndex,
                  publishMinute: read.publishMinute,
                  readMinute: scheduledStart,
                  plannedCollectorId: findPlannedCollector(scenario, read.key, read.requiredWindow),
                },
              });
            }
          }

          // Enqueue Completion exactly once.
          const compEntry = makeEntry(
            scheduledStart + job.runDuration,
            1,
            job.id,
            'Completion',
            null,
            job.id,
          );
          insertAndSort(compEntry);
        } else {
          // Enter Blocked.
          meta.record.completionStatus = 'Blocked';
          meta.record.waitStart = scheduledStart;
          meta.state = 'Blocked';
          appendTrace(trace, {
            eventMinute: scheduledStart,
            kind: 'BlockedWait',
            reportId: job.id,
            detail: { waitStart: scheduledStart, key: wp.key, requiredWindow: wp.requiredWindow },
          });
        }
        break;
      }

      // ── PHASE 2: WaitEnd ─────────────────────────────────────────────────
      case 'WaitEnd': {
        const tPub: Minute = (event.payload as { tPub: Minute }).tPub;
        const wp = job.waitPolicy!;
        const effectiveStart: Minute = Math.max(job.scheduledStart, tPub);

        // Step 1: Freshness gate (before timing).
        const freshRead = classifyRead({
          store,
          key: wp.key,
          requiredWindow: wp.requiredWindow,
          readMinute: effectiveStart,
          scheduledPublishMinute: job.scheduledPublishMinutes?.[`${wp.key}:${wp.requiredWindow}`],
          fallbackEnabled: job.fallbackEnabled ?? false,
          maxArtifactAge: scenario.maxArtifactAge,
          jobId: job.id,
          attemptId: job.id,
        });

        if (freshRead.state !== 'Fresh') {
          // Not admissible; stay Blocked. Phase 3 will handle expiry at the deadline.
          continue;
        }

        // Step 2: Timing gate.
        if (effectiveStart > wp.deadline) {
          meta.record.completionStatus = 'DeadlineMissed';
          meta.record.missReason = 'ArtifactNeverPublished';
          meta.record.waitOutcome = 'DeadlineMissed';
          meta.state = 'Resolved';
          appendTrace(trace, {
            eventMinute: event.minute,
            kind: 'DeadlineMiss',
            reportId: job.id,
            detail: { missReason: 'ArtifactNeverPublished', key: wp.key, requiredWindow: wp.requiredWindow },
          });
          break;
        }

        if (effectiveStart + job.runDuration > wp.deadline) {
          meta.record.completionStatus = 'DeadlineMissed';
          meta.record.missReason = 'CompletionWouldExceedCutoff';
          meta.record.waitOutcome = 'DeadlineMissed';
          meta.state = 'Resolved';
          appendTrace(trace, {
            eventMinute: event.minute,
            kind: 'DeadlineMiss',
            reportId: job.id,
            detail: { missReason: 'CompletionWouldExceedCutoff', key: wp.key, requiredWindow: wp.requiredWindow },
          });
          break;
        }

        // Admitted.
        const reads = job.inputs.map((inp) =>
          classifyRead({
            store,
            key: inp.key,
            requiredWindow: inp.requiredWindow,
            readMinute: effectiveStart,
            scheduledPublishMinute: job.scheduledPublishMinutes?.[`${inp.key}:${inp.requiredWindow}`],
            fallbackEnabled: job.fallbackEnabled ?? false,
            maxArtifactAge: scenario.maxArtifactAge,
            jobId: job.id,
            attemptId: job.id,
          }),
        );

        meta.record.reads = reads;
        meta.record.inputFreshnessStatus = worstFreshness(reads.map((r) => r.state));
        meta.record.actualStart = effectiveStart;
        meta.record.waitEnd = tPub;
        meta.record.waitOutcome = 'ArtifactArrived';
        meta.record.completionStatus = 'Success'; // tentative
        meta.state = 'Running';

        // Enqueue Completion exactly once.
        const compEntry = makeEntry(
          effectiveStart + job.runDuration,
          1,
          job.id,
          'Completion',
          null,
          job.id,
        );
        insertAndSort(compEntry);
        break;
      }

      // ── PHASE 3: DeadlineMiss ────────────────────────────────────────────
      case 'DeadlineMiss': {
        meta.record.completionStatus = 'DeadlineMissed';
        meta.record.missReason = 'ArtifactNeverPublished';
        meta.record.waitOutcome = 'DeadlineMissed';
        meta.state = 'Resolved';
        appendTrace(trace, {
          eventMinute: event.minute,
          kind: 'DeadlineMiss',
          reportId: job.id,
          detail: {
            missReason: 'ArtifactNeverPublished',
            key: job.waitPolicy?.key,
            requiredWindow: job.waitPolicy?.requiredWindow,
          },
        });
        break;
      }
    }
  }

  return {
    scenarioId: scenario.scenarioId,
    runs: Array.from(runs.values()).map((m) => m.record),
    slots: dedup.allSlots(),
    trace,
    eventLog,
  };
}

function findPlannedCollector(
  scenario: ScenarioConfig,
  key: string,
  windowIndex: number,
): string | null {
  for (const job of scenario.jobs) {
    if (job.output?.key === key && job.output?.windowIndex === windowIndex) {
      return job.id;
    }
  }
  return null;
}
