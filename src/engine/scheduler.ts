import type { EventLogEntry, EventTypePriority, Minute, ScenarioConfig } from './types.ts';
import { sortKey, compareEntries } from './tie-break.ts';

export type QueueEntry = EventLogEntry & {
  jobId: string;
};

/**
 * Build the initial sorted event queue from a scenario config.
 *
 * Only Admission (all jobs) and DeadlineMiss (wait-policy jobs) are enqueued
 * at build time. Completion events are NEVER enqueued here — they are
 * enqueued exactly once when a job enters Running state.
 * WaitEnd events are enqueued dynamically by the simulator when store.add fires.
 */
export function buildQueue(scenario: ScenarioConfig): QueueEntry[] {
  const entries: QueueEntry[] = [];

  for (const job of scenario.jobs) {
    // Every job gets an Admission event at its scheduled start.
    entries.push(makeEntry(job.scheduledStart, 2, job.id, 'Admission', null, job.id));

    // Wait-policy jobs get a tentative DeadlineMiss guard.
    if (job.waitPolicy) {
      entries.push(makeEntry(job.waitPolicy.deadline, 4, job.id, 'DeadlineMiss', null, job.id));
    }
  }

  // Sort and validate for duplicate triplets.
  entries.sort((a, b) => {
    if (
      a.minute === b.minute &&
      a.typePriority === b.typePriority &&
      a.entityId === b.entityId
    ) {
      throw new Error(
        `Configuration error: duplicate event key ` +
          `(minute=${a.minute}, typePriority=${a.typePriority}, entityId="${a.entityId}")`,
      );
    }
    if (a.sortKey < b.sortKey) return -1;
    if (a.sortKey > b.sortKey) return 1;
    return 0;
  });

  return entries;
}

export function makeEntry(
  minute: Minute,
  typePriority: EventTypePriority,
  entityId: string,
  kind: string,
  payload: unknown,
  jobId: string,
): QueueEntry {
  return {
    minute,
    typePriority,
    entityId,
    sortKey: sortKey(minute, typePriority, entityId),
    kind,
    payload,
    jobId,
  };
}
