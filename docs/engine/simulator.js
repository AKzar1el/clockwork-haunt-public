             
                                                 
                                                                                                               
                    
import { ArtifactStore } from './store.js';
import { classifyRead, publishHintKey, worstFreshness } from './classifier.js';
import { DedupGuard } from './dedup.js';
import { appendTrace } from './tracer.js';
import { buildQueue, makeEntry } from './scheduler.js';

export class ScenarioValidationError extends Error {
  constructor(message        ) {
    super(message);
    this.name = 'ScenarioValidationError';
  }
}

                   
                     
                       
                  
                          
 

function firstMinuteAfter(ordered                   , minute        )         {
  let low = 0;
  let high = ordered.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ordered[middle] <= minute) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function simulate(scenario                )                   {
  const runs = new Map                 ();
  const activeWaiters = new Map                            ();
  const wantedSupplyWindows = new Map                     ();
  const producers = new Map                       ();
  const publishHints = new Map                           ();
  const slot = (key        , window        ) => JSON.stringify([key, window]);
  const inDay = (minute        ) => Number.isInteger(minute) && minute >= 0 && minute <= 1439;
  const requireObject = (value         , field        ) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      throw new ScenarioValidationError(field + ' must be an object');
    }
  };
  const requireIdentifier = (identifier         , field        ) => {
    if (typeof identifier !== 'string' || !identifier.trim()) throw new ScenarioValidationError(field + ' must be a non-empty string');
  };
  const requireBoolean = (value         , field        , optional = false) => {
    if (optional && value === undefined) return;
    if (typeof value !== 'boolean') throw new ScenarioValidationError(field + ' must be a boolean');
  };
  const requireWindow = (index        , field        ) => {
    if (!Number.isSafeInteger(index)) throw new ScenarioValidationError(field + ' must be a safe integer window index');
  };
  requireObject(scenario, 'Scenario');
  if (!Array.isArray(scenario.jobs)) throw new ScenarioValidationError('Scenario jobs must be an array');
  if (scenario.preloadedArtifacts !== undefined && !Array.isArray(scenario.preloadedArtifacts)) {
    throw new ScenarioValidationError('Preloaded artifacts must be an array');
  }
  requireIdentifier(scenario.scenarioId, 'scenarioId');
  if (!Number.isInteger(scenario.maxArtifactAge) || scenario.maxArtifactAge < 0) {
    throw new ScenarioValidationError('maxArtifactAge must be a non-negative integer');
  }
  for (const record of scenario.preloadedArtifacts ?? []) {
    requireObject(record, 'Preloaded artifact');
    requireIdentifier(record.key, 'Preloaded key');
    requireIdentifier(record.attemptId, 'Preloaded attemptId');
    requireBoolean(record.producerValid, 'Preloaded producerValid');
    if (!inDay(record.publishMinute)) throw new ScenarioValidationError('Preloaded publishMinute out of [0,1439]');
    requireWindow(record.windowIndex, 'Preloaded windowIndex');
  }
  // ── Validate minute bounds (AC-043) ──────────────────────────────────────
  for (const job of scenario.jobs) {
    requireObject(job, 'Job');
    requireIdentifier(job.id, 'Job id');
    if (!Array.isArray(job.inputs)) throw new ScenarioValidationError('Inputs for ' + job.id + ' must be an array');
    if (job.output !== undefined) requireObject(job.output, 'Output');
    if (job.waitPolicy !== undefined) requireObject(job.waitPolicy, 'Wait policy');
    if (job.scheduledPublishMinutes !== undefined) requireObject(job.scheduledPublishMinutes, 'Scheduled publish minutes');
    requireBoolean(job.fallbackEnabled, 'fallbackEnabled', true);
    requireBoolean(job.deduplicationEnabled, 'deduplicationEnabled', true);
    if (runs.has(job.id)) throw new ScenarioValidationError('Configuration error: duplicate job ID ' + job.id);
    if (!inDay(job.scheduledStart)) {
      throw new ScenarioValidationError(`Job "${job.id}" scheduledStart ${job.scheduledStart} out of [0,1439]`);
    }
    if (!Number.isInteger(job.runDuration) || job.runDuration <= 0) {
      throw new ScenarioValidationError(`Job "${job.id}" runDuration must be a positive integer`);
    }
    if (job.completionOutcome !== undefined && job.completionOutcome !== 'Success' && job.completionOutcome !== 'Failure') {
      throw new ScenarioValidationError('Invalid declared completion outcome for ' + job.id);
    }
    const finMin = job.scheduledStart + job.runDuration;
    if (finMin > 1439) {
      throw new ScenarioValidationError(`Job "${job.id}" completion minute ${finMin} exceeds 1439`);
    }
    for (const [hint, minute] of Object.entries(job.scheduledPublishMinutes ?? {})) {
      if (!inDay(minute)) throw new ScenarioValidationError('Scheduled publish minute out of [0,1439]');
      const separator = hint.lastIndexOf(':');
      const key = hint.slice(0,separator);
      const window = Number(hint.slice(separator+1));
      if (separator < 1 || !key.trim() || !Number.isSafeInteger(window) || publishHintKey(key,window) !== hint) {
        throw new ScenarioValidationError('Scheduled publish hint key must use a non-empty key and a canonical integer window, separated by a colon.');
      }
      let hints = publishHints.get(job.id);
      if (!hints) publishHints.set(job.id,hints = new Map());
      hints.set(hint,minute);
    }
    const inputSlots = job.inputs.length > 1 ? new Set        () : undefined;
    for (const input of job.inputs) {
      requireObject(input, 'Input');
      requireIdentifier(input.key, 'Input key');
      requireWindow(input.requiredWindow, 'Input requiredWindow');
      if (!inputSlots) continue;
      const identity = slot(input.key, input.requiredWindow);
      if (inputSlots.has(identity)) throw new ScenarioValidationError('Duplicate input slot for ' + job.id + ': ' + identity);
      inputSlots.add(identity);
    }
    if (job.waitPolicy) {
      requireIdentifier(job.waitPolicy.key, 'Wait policy key');
      requireWindow(job.waitPolicy.requiredWindow, 'Wait policy requiredWindow');
      if (!inDay(job.waitPolicy.deadline)) {
        throw new ScenarioValidationError(`Job "${job.id}" deadline ${job.waitPolicy.deadline} out of [0,1439]`);
      }
      if (job.waitPolicy.deadline < job.scheduledStart) {
        throw new ScenarioValidationError(`Job "${job.id}" deadline ${job.waitPolicy.deadline} precedes scheduledStart ${job.scheduledStart}`);
      }
      const {key,requiredWindow} = job.waitPolicy;
      let windows = wantedSupplyWindows.get(key);
      if (!windows) wantedSupplyWindows.set(key,windows = new Set());
      windows.add(requiredWindow);
    }
    if (job.output) {
      requireIdentifier(job.output.key, 'Output key');
      requireWindow(job.output.windowIndex, 'Output windowIndex');
      const key = slot(job.output.key, job.output.windowIndex);
      const enabled = job.deduplicationEnabled ?? true;
      const prior = producers.get(key);
      // Every contender for a slot must match its stored planned producer's
      // policy, even when this contender does not win the planning tie-break.
      if (prior && (prior.deduplicationEnabled ?? true) !== enabled) {
        throw new ScenarioValidationError('Configuration error: conflicting deduplication policy for output slot ' + key);
      }
      const priorFinish = prior ? prior.scheduledStart + prior.runDuration : Infinity;
      if (!prior || finMin < priorFinish || (finMin === priorFinish && job.id < prior.id)) producers.set(key, job);
    }
    // Keep the validated definition with its run so dispatch needs one lookup.
    runs.set(job.id, {
      job,
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
        waitResolutionMinute: null,
        waitOutcome: null,
        missReason: null,
        reads: [],
      },
    });
  }

  // ── Initialise ───────────────────────────────────────────────────────────
  const store = new ArtifactStore();
  function readInputs(job               , minute        , gateArtifact                 ) {
    // Use the validated enumerable hints retained in the replay input contract.
    const hints = publishHints.get(job.id);
    return job.inputs.map(inp => classifyRead({
      store, key: inp.key, requiredWindow: inp.requiredWindow, readMinute: minute,
      scheduledPublishMinute: hints?.get(publishHintKey(inp.key,inp.requiredWindow)),
      fallbackEnabled: job.fallbackEnabled ?? false, maxArtifactAge: scenario.maxArtifactAge,
      jobId: job.id, attemptId: job.id,
      knownExact: gateArtifact?.key === inp.key && gateArtifact.windowIndex === inp.requiredWindow ? gateArtifact : undefined,
    }));
  }
  let gateKey                    ;
  let gateWindow = 0;
  let gateMinute         = 0;
  let gateResult                            ;
  function freshPolicyArtifact(policy            , minute        ) {
    const {key,requiredWindow} = policy;
    // A fanout can check the same immutable winner or miss many times.
    if (gateKey === key && gateWindow === requiredWindow && gateMinute === minute) return gateResult;
    const artifact = store.get(key, requiredWindow, minute);
    gateKey = key;
    gateWindow = requiredWindow;
    gateMinute = minute;
    gateResult = artifact?.producerValid && minute - artifact.publishMinute <= scenario.maxArtifactAge ? artifact : undefined;
    return gateResult;
  }
  let lastGateArtifact                            ;
  let lastGateObservation                                ;
  function policyEvidence(artifact                , decisionMinute        ) {
    // Consecutive reports can observe the same immutable artifact at the same minute.
    if (lastGateArtifact === artifact && lastGateObservation?.decisionMinute === decisionMinute) return lastGateObservation;
    lastGateArtifact = artifact;
    lastGateObservation = Object.freeze({key:artifact.key,windowIndex:artifact.windowIndex,
      producerAttemptId:artifact.attemptId,publishMinute:artifact.publishMinute,
      decisionMinute,ageAtDecision:decisionMinute-artifact.publishMinute});
    return lastGateObservation;
  }
  const dedup = new DedupGuard();
  const trace               = [];
  const planned = (key        , window        ) => producers.get(slot(key, window))?.id ?? null;

  function timingDetail(policy            , artifact                , earliestFinish        ) {
    return { missReason: 'CompletionWouldExceedCutoff', key: policy.key, requiredWindow: policy.requiredWindow,
      plannedCollectorId: planned(policy.key, policy.requiredWindow),
      observedPublishMinute: artifact.publishMinute, observedProducerAttemptId: artifact.attemptId,
      earliestFinish, finishCutoff: policy.deadline };
  }
  function traceStaleReads(job               , reads                       ) {
    for (const read of reads) {
      if (read.state !== 'Stale') continue;
      appendTrace(trace, {
        eventMinute: read.readMinute, kind: 'StaleRead', reportId: job.id,
        detail: {
          readId: read.readId, state: read.state,
          key: read.key, requiredWindow: read.requiredWindow, fallbackWindow: read.actualWindowIndex,
          publishMinute: read.publishMinute, readMinute: read.readMinute,
          plannedCollectorId: planned(read.key, read.requiredWindow),
          producerAttemptId: read.producerAttemptId,
          staleReason: read.staleReason,
        },
      });
    }
  }
  const eventLog                  = [];

  // Load preloaded artifacts before the simulation clock starts.
  const suppliedMinutes = new Map                     ();
  for (const a of scenario.preloadedArtifacts ?? []) {
    store.add(a);
    // Ordinary reads still see every supply; only watched windows need a wake index.
    if (a.producerValid && wantedSupplyWindows.get(a.key)?.has(a.windowIndex)) {
      const key = slot(a.key,a.windowIndex);
      let minutes = suppliedMinutes.get(key);
      if (!minutes) suppliedMinutes.set(key,minutes = new Set());
      minutes.add(a.publishMinute);
    }
  }
  const orderedSuppliedMinutes = new Map([...suppliedMinutes]
    .map(([key, minutes]) => [key, [...minutes].sort((a, b) => a - b)]         ));

  // Build the initial static queue.
  const queue = buildQueue(scenario);

  function startWaiting(job               , policy            ) {
    const key = slot(policy.key, policy.requiredWindow);
    const set = activeWaiters.get(key) ?? new Set               ();
    set.add(job);
    activeWaiters.set(key, set);
  }

  function finishWaiting(job               , policy            ) {
    const key = slot(policy.key, policy.requiredWindow);
    const set = activeWaiters.get(key);
    set?.delete(job);
    if (set?.size === 0) activeWaiters.delete(key);
  }

  function enqueueWake(job               , publishMinute        ) {
    if (publishMinute > job.waitPolicy .deadline) return false;
    const meta = runs.get(job.id) ;
    // Every queued wake comes from a valid publication visible at its minute.
    // Only an earlier minute can improve on the wake already queued.
    if (meta.nextWakeMinute !== undefined && meta.nextWakeMinute <= publishMinute) return false;
    const replaced = meta.nextWakeMinute !== undefined;
    meta.nextWakeMinute = publishMinute;
    queue.push(makeEntry(publishMinute, 3, job.id, 'WaitEnd', { tPub: publishMinute }, job.id));
    return replaced;
  }

  // Listen for store additions to enqueue WaitEnd events.
  store.onAdd((artifact                ) => {
    if (gateKey === artifact.key && gateWindow === artifact.windowIndex) gateKey = undefined;
    if (!activeWaiters.size) return;
    const waiters = activeWaiters.get(slot(artifact.key, artifact.windowIndex));
    if (!waiters) return;
    let replaced = 0;
    for (const job of waiters) {
      if (enqueueWake(job,artifact.publishMinute)) replaced++;
    }
    // A large shared publication can replace thousands of supplied wakes.
    // Rebuild the queue only for substantial batches; lone stale wakes are cheap.
    if (replaced >= 64 && replaced * 4 >= queue.pendingCount) {
      queue.discardPendingWhere(entry=>entry.kind==='WaitEnd' && runs.get(entry.jobId)?.nextWakeMinute!==entry.minute);
    }
  });

  // ── Event loop ────────────────────────────────────────────────────────────
  for (let event = queue.pop(); event; event = queue.pop()) {
    const meta = runs.get(event.jobId) ;
    const job = meta.job;

    // Event-specific guards.
    if (event.kind === 'Admission' && meta.state !== 'Scheduled') continue;
    if (event.kind === 'WaitEnd' && meta.state !== 'Blocked') continue;
    if (event.kind === 'DeadlineMiss' && meta.state !== 'Blocked' &&
        !(meta.state === 'Scheduled' && job.waitPolicy?.deadline === job.scheduledStart)) continue;
    if (event.kind === 'Completion' && meta.state !== 'Running') continue;

    if (event.kind !== 'Completion') eventLog.push(event);

    switch (event.kind) {
      // ── PHASE 1: Completion ──────────────────────────────────────────────
      case 'Completion': {
        const completionMinute = meta.record.actualStart  + job.runDuration;
        meta.record.completionMinute = completionMinute;
        const outcome = job.completionOutcome ?? 'Success';
        meta.record.completionStatus = outcome;
        meta.state = 'Resolved';
        let output                              = null;

        if (job.output && outcome === 'Failure') {
          output = {kind:'Failed', attemptId:job.id, key:job.output.key, windowIndex:job.output.windowIndex};
        } else if (job.output) {
          const suppression = dedup.commit(
            job.output.key,
            job.output.windowIndex,
            job.id,
            completionMinute,
            job.deduplicationEnabled ?? true,
          );
          if (suppression === null) {
            output = {kind:'Accepted', attemptId:job.id, key:job.output.key, windowIndex:job.output.windowIndex};
            store.add({
              key: job.output.key,
              windowIndex: job.output.windowIndex,
              publishMinute: completionMinute,
              attemptId: job.id,
              producerValid: true,
            });
          } else {
            output = {kind:'Suppressed', attemptId:suppression.attemptId, key:job.output.key, windowIndex:job.output.windowIndex,
              acceptedEffectId:suppression.acceptedEffectId};
            appendTrace(trace, {
              eventMinute: completionMinute,
              kind: 'Suppression',
              reportId: job.id,
              detail: {
                attemptId: suppression.attemptId,
                key: job.output.key,
                windowIndex: job.output.windowIndex,
                suppressedAtMinute: suppression.suppressedAtMinute,
                acceptedEffectId: suppression.acceptedEffectId,
                reason: suppression.reason,
              },
            });
          }
        }
        eventLog.push(Object.freeze({ ...event, completion:Object.freeze({outcome,output:output && Object.freeze(output)}) }));
        break;
      }

      // ── PHASE 2: Admission ───────────────────────────────────────────────
      case 'Admission': {
        const scheduledStart = job.scheduledStart;

        const wp = job.waitPolicy;
        const policyArtifact = wp && freshPolicyArtifact(wp, scheduledStart);
        if (policyArtifact) meta.record.policyArtifact = policyEvidence(policyArtifact,scheduledStart);

        if (wp && policyArtifact && scheduledStart + job.runDuration > wp.deadline) {
          const missReason = 'CompletionWouldExceedCutoff';
          meta.record.completionStatus = 'DeadlineMissed';
          meta.record.waitEnd = policyArtifact.publishMinute;
          meta.record.waitResolutionMinute = scheduledStart;
          meta.record.waitOutcome = 'DeadlineMissed';
          meta.record.missReason = missReason;
          meta.state = 'Resolved';
          appendTrace(trace, {
            eventMinute: scheduledStart, kind: 'DeadlineMiss', reportId: job.id,
            detail: timingDetail(wp, policyArtifact, scheduledStart + job.runDuration),
          });
          break;
        }

        if (policyArtifact || !wp) {
          // Admit immediately.
          const preReads = readInputs(job, scheduledStart, policyArtifact);
          meta.record.reads = preReads;
          meta.record.inputFreshnessStatus = worstFreshness(preReads);
          meta.record.actualStart = scheduledStart;
          meta.record.completionStatus = 'Success'; // tentative; confirmed at Completion
          meta.state = 'Running';

          traceStaleReads(job, preReads);

          // Enqueue Completion exactly once.
          const compEntry = makeEntry(
            scheduledStart + job.runDuration,
            1,
            job.id,
            'Completion',
            null,
            job.id,
          );
          queue.push(compEntry);
        } else {
          // A known valid supplied publication is immutable and fresh at its
          // own minute. That wake (or an earlier actual publication) will
          // resolve even a run that no longer has enough time to finish.
          const minutes = orderedSuppliedMinutes.get(slot(wp.key, wp.requiredWindow));
          const nextMinute = minutes?.[firstMinuteAfter(minutes,scheduledStart)];
          const guaranteedWake = nextMinute !== undefined && nextMinute <= wp.deadline;
          if (!guaranteedWake) queue.push(makeEntry(wp.deadline,4,job.id,'DeadlineMiss',null,job.id));
          // With no time left at admission there is no wait interval to record.
          // Let the same-minute cutoff event resolve the still-scheduled job.
          if (scheduledStart === wp.deadline) break;
          // Enter Blocked.
          meta.record.completionStatus = 'Blocked';
          meta.record.waitStart = scheduledStart;
          meta.state = 'Blocked';
          startWaiting(job, wp);
          // Supplied artifacts enter the store up front but become visible only
          // at their publication minute. Give waiters the same notification
          // they would receive for a publication made by a simulated job.
          if (guaranteedWake) enqueueWake(job,nextMinute);
          appendTrace(trace, {
            eventMinute: scheduledStart,
            kind: 'BlockedWait',
            reportId: job.id,
            detail: { waitStart: scheduledStart, key: wp.key, requiredWindow: wp.requiredWindow, plannedCollectorId: planned(wp.key, wp.requiredWindow) },
          });
        }
        break;
      }

      // ── PHASE 2: WaitEnd ─────────────────────────────────────────────────
      case 'WaitEnd': {
        const tPub = event.minute; // the queue enforces agreement with the recorded publication payload
        const wp = job.waitPolicy ;
        const effectiveStart         = Math.max(job.scheduledStart, tPub);

        // Step 1: Freshness gate (before timing).
        const freshArtifact = freshPolicyArtifact(wp, effectiveStart);

        if (!freshArtifact) throw new Error('Internal error: queued wait has no fresh publication at its wake minute.');
        meta.record.policyArtifact = policyEvidence(freshArtifact,effectiveStart);
        finishWaiting(job, wp);

        // Step 2: Timing gate.
        if (effectiveStart + job.runDuration > wp.deadline) {
          meta.record.completionStatus = 'DeadlineMissed';
          meta.record.missReason = 'CompletionWouldExceedCutoff';
          meta.record.waitOutcome = 'DeadlineMissed';
          meta.record.waitEnd = freshArtifact.publishMinute;
          meta.record.waitResolutionMinute = event.minute;
          meta.state = 'Resolved';
          appendTrace(trace, {
            eventMinute: event.minute,
            kind: 'DeadlineMiss',
            reportId: job.id,
            detail: timingDetail(wp, freshArtifact, effectiveStart + job.runDuration),
          });
          break;
        }

        // Admitted.
        const reads = readInputs(job, effectiveStart, freshArtifact);

        meta.record.reads = reads;
        traceStaleReads(job, reads);
        meta.record.inputFreshnessStatus = worstFreshness(reads);
        meta.record.actualStart = effectiveStart;
        meta.record.waitEnd = tPub;
        meta.record.waitResolutionMinute = event.minute;
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
        queue.push(compEntry);
        break;
      }

      // ── PHASE 3: DeadlineMiss ────────────────────────────────────────────
      case 'DeadlineMiss': {
        const wp = job.waitPolicy ;
        finishWaiting(job, wp);
        const seen = store.get(wp.key, wp.requiredWindow, event.minute);
        const plannedCollectorId = planned(wp.key, wp.requiredWindow);
        const producer = plannedCollectorId === null ? undefined : runs.get(plannedCollectorId);
        const failedByCutoff = producer?.state === 'Resolved' && producer.record.completionStatus === 'Failure';
        const artifactAtCutoff = seen === undefined ? (failedByCutoff ? 'ProducerFailed' : 'Absent')
          : !seen.producerValid ? 'InvalidProducer' : 'Expired';
        meta.record.completionStatus = 'DeadlineMissed';
        meta.record.missReason = 'ArtifactNeverPublished';
        meta.record.waitOutcome = 'DeadlineMissed';
        meta.record.waitResolutionMinute = event.minute;
        meta.state = 'Resolved';
        appendTrace(trace, {
          eventMinute: event.minute,
          kind: 'DeadlineMiss',
          reportId: job.id,
          detail: {
            missReason: 'ArtifactNeverPublished',
            key: wp.key,
            requiredWindow: wp.requiredWindow,
            plannedCollectorId,
            artifactAtCutoff,
            observedPublishMinute: seen?.publishMinute ?? null,
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

