import type { ArtifactReadRecord, ArtifactRecord, Minute, ReadState } from './types.ts';
import type { ArtifactStore } from './store.ts';

export function publishHintKey(key: string, window: number): string {
  return `${key}:${window}`;
}

export interface ClassifyParams {
  store: ArtifactStore;
  key: string;
  requiredWindow: number;
  readMinute: Minute;
  scheduledPublishMinute: Minute | undefined;
  fallbackEnabled: boolean;
  maxArtifactAge: number;
  jobId: string;
  attemptId: string;
  // Optional exact winner already selected by the policy gate for this slot and minute.
  knownExact?: ArtifactRecord;
}

/**
 * Classify a single artifact read and return a frozen ArtifactReadRecord.
 * Priority order (AC-006): Fresh → Stale → Unknown → Missing.
 */
export function classifyRead(p: ClassifyParams): ArtifactReadRecord {
  const {
    store, key, requiredWindow, readMinute,
    scheduledPublishMinute, fallbackEnabled, maxArtifactAge,
    jobId, attemptId,
  } = p;
  const readId = JSON.stringify([attemptId, key, requiredWindow, readMinute]);

  // ── Fresh (AC-002) ──────────────────────────────────────────────────────
  const exact = p.knownExact ?? store.get(key, requiredWindow, readMinute);
  if (exact && exact.producerValid) {
    const age = readMinute - exact.publishMinute;
    if (age >= 0 && age <= maxArtifactAge) {
      return Object.freeze<ArtifactReadRecord>({
        readId, jobId, attemptId, key, requiredWindow,
        actualWindowIndex: requiredWindow,
        producerAttemptId: exact.attemptId,
        state: 'Fresh',
        publishMinute: exact.publishMinute,
        readMinute,
        artifactAge: age,
      });
    }
  }

  // ── Stale arm (b): same-window, valid producer, over-age (AC-003b) ──────
  if (exact && exact.producerValid) {
    const age = readMinute - exact.publishMinute;
    if (age > maxArtifactAge) {
      return Object.freeze<ArtifactReadRecord>({
        readId, jobId, attemptId, key, requiredWindow,
        actualWindowIndex: requiredWindow,
        producerAttemptId: exact.attemptId,
        state: 'Stale',
        staleReason: 'ExpiredExact',
        publishMinute: exact.publishMinute,
        readMinute,
        artifactAge: age,
      });
    }
  }

  // ── Stale arm (a): prior-window fallback, valid producer (AC-003a) ──────
  if (fallbackEnabled && !exact) {
    const prior = store.getBestBelow(key, requiredWindow, readMinute);
    if (prior) {
      const age = readMinute - prior.publishMinute;
      if (age >= 0) {
        return Object.freeze<ArtifactReadRecord>({
          readId, jobId, attemptId, key, requiredWindow,
          actualWindowIndex: prior.windowIndex,
          producerAttemptId: prior.attemptId,
          state: 'Stale',
          staleReason: 'PriorWindow',
          publishMinute: prior.publishMinute,
          readMinute,
          artifactAge: age,
        });
      }
    }
  }

  // ── Unknown arm (b): artifact present but invalid producer (AC-004b) ────
  if (exact && !exact.producerValid) {
    return Object.freeze<ArtifactReadRecord>({
      readId, jobId, attemptId, key, requiredWindow,
      actualWindowIndex: null,
      producerAttemptId: null,
      state: 'Unknown',
      unavailableReason: 'InvalidProducer',
      publishMinute: null,
      readMinute,
      artifactAge: null,
    });
  }

  // ── Unknown arm (a): no artifact, future scheduled publish (AC-004a) ────
  if (!exact && scheduledPublishMinute !== undefined && scheduledPublishMinute > readMinute) {
    return Object.freeze<ArtifactReadRecord>({
      readId, jobId, attemptId, key, requiredWindow,
      actualWindowIndex: null,
      producerAttemptId: null,
      state: 'Unknown',
      unavailableReason: 'PublicationPending',
      publishMinute: null,
      readMinute,
      artifactAge: null,
    });
  }

  // ── Missing (AC-005) ────────────────────────────────────────────────────
  return Object.freeze<ArtifactReadRecord>({
    readId, jobId, attemptId, key, requiredWindow,
    actualWindowIndex: null,
    producerAttemptId: null,
    state: 'Missing',
    unavailableReason: 'NotAvailableAtRead',
    publishMinute: null,
    readMinute,
    artifactAge: null,
  });
}

/** Derive worst-case InputFreshnessStatus across all reads (AC-012). */
const freshnessRank: Record<ReadState, number> = { Fresh: 0, Stale: 1, Unknown: 2, Missing: 3 };

export function worstFreshness(
  reads: readonly Pick<ArtifactReadRecord, 'state'>[],
): ReadState | null {
  if (reads.length === 0) return null;
  let worst: ReadState = 'Fresh';
  for (const { state } of reads) {
    if (state === 'Missing') return state;
    if (freshnessRank[state] > freshnessRank[worst]) worst = state;
  }
  return worst;
}
