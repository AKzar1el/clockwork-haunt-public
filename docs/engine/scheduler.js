                                                                                           
import { sortKey } from './tie-break.js';

                                                     

                                                                   
                
                        
   

function immutableEntry(entry            )             {
  if (Object.isFrozen(entry) && (entry.payload === null || Object.isFrozen(entry.payload))) return entry;
  return Object.freeze({ ...entry, payload: entry.payload === null ? null : Object.freeze({ ...entry.payload }) });
}

/** Min-heap over the same deterministic ordering as the evidence log. */
export class EventQueue {
                   heap               = [];
                   keys = new Set        ();

  constructor(initial                       = []) {
    for (const entry of initial) {
      this.heap.push(this.track(entry));
    }
    for (let i = (this.heap.length >>> 1) - 1; i >= 0; i--) this.siftDown(i, this.heap[i]);
  }

          track(entry            ) {
    const stored = immutableEntry(entry);
    if (!Number.isInteger(stored.minute) || stored.minute < 0 || stored.minute > 1439 ||
        !Number.isInteger(stored.typePriority) || stored.typePriority < 1 || stored.typePriority > 4) {
      throw new Error('Configuration error: event minute or phase out of range');
    }
    if (stored.sortKey !== sortKey(stored.minute, stored.typePriority, stored.entityId)) {
      throw new Error('Configuration error: event sort key does not match its minute, phase and entity');
    }
    if (stored.kind === 'WaitEnd' && (stored.typePriority !== 3 || stored.payload?.tPub !== stored.minute)) {
      throw new Error('Configuration error: wait wake must match its scheduled publication minute and phase');
    }
    // The sort key alone cannot distinguish a mislabeled completion from an
    // admission, or the entity named by the log from the job being dispatched.
    const kindPhase = stored.kind === 'Completion' ? 1 : stored.kind === 'Admission' ? 2
      : stored.kind === 'WaitEnd' ? 3 : stored.kind === 'DeadlineMiss' ? 4 : undefined;
    if (stored.typePriority !== kindPhase) throw new Error('Configuration error: event kind and phase do not agree');
    if (stored.entityId !== stored.jobId) throw new Error('Configuration error: event entity must match its job');
    if (stored.kind !== 'WaitEnd' && stored.payload !== null) {
      throw new Error('Configuration error: event payload only for a wait wake');
    }
    if (this.keys.has(stored.sortKey)) throw new Error('Configuration error: duplicate event key ' + stored.sortKey);
    this.keys.add(stored.sortKey);
    return stored;
  }

  push(candidate            ) {
    const entry = this.track(candidate);
    let i = this.heap.length;
    this.heap.push(entry);
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      if (this.heap[parent].sortKey < entry.sortKey) break;
      this.heap[i] = this.heap[parent];
      i = parent;
    }
    this.heap[i] = entry;
  }

  pop()                         {
    const first = this.heap[0];
    const last = this.heap.pop();
    if (!first || !last) return undefined;
    if (this.heap.length) this.siftDown(0, last);
    return first;
  }

  get pendingCount() { return this.heap.length; }

  discardPendingWhere(discard                                ) {
    let write = 0;
    for (const entry of this.heap) {
      if (!discard(entry)) this.heap[write++] = entry;
    }
    this.heap.length = write;
    // A discarded key still belongs to this simulation; never recycle it.
    for (let i = (write >>> 1) - 1; i >= 0; i--) this.siftDown(i,this.heap[i]);
  }

          siftDown(i        , entry            ) {
    while (i * 2 + 1 < this.heap.length) {
      let child = i * 2 + 1;
      if (child + 1 < this.heap.length && this.heap[child + 1].sortKey < this.heap[child].sortKey) child++;
      if (entry.sortKey < this.heap[child].sortKey) break;
      this.heap[i] = this.heap[child];
      i = child;
    }
    this.heap[i] = entry;
  }
}

/**
 * Build a min-heap for the initial events in linear time.
 *
 * Only admission events are known to be needed for every job. The simulator
 * schedules cutoff checks when admission finds no fresh policy artifact,
 * completion when a job actually starts, and wakeups for useful publications.
 */
export function buildQueue(scenario                )             {
  return new EventQueue(admissionEntries(scenario.jobs));
}

// Let the heap consume admissions directly instead of storing a staging array.
function* admissionEntries(jobs                        )                               {
  for (const job of jobs) {
    yield makeEntry(job.scheduledStart, 2, job.id, 'Admission', null, job.id);
  }
}

export function makeEntry(
  minute        ,
  typePriority                   ,
  entityId        ,
  kind        ,
  payload              ,
  jobId        ,
)             {
  return immutableEntry({
    minute,
    typePriority,
    entityId,
    sortKey: sortKey(minute, typePriority, entityId),
    kind,
    payload,
    jobId,
  });
}
