// All shared types — no logic.

export type Minute = number; // integer in [0, 1439]

export type ReadState = 'Fresh' | 'Stale' | 'Unknown' | 'Missing';

export type CompletionStatus = 'Success' | 'Failure' | 'Blocked' | 'DeadlineMissed';

export type InputFreshnessStatus = 'Fresh' | 'Stale' | 'Unknown' | 'Missing';

export type WaitOutcome = 'ArtifactArrived' | 'DeadlineMissed';

export type MissReason = 'ArtifactNeverPublished' | 'CompletionWouldExceedCutoff';

// Phase mapping:
//   1 = Completion   (Phase 1)
//   2 = Admission    (Phase 2)
//   3 = WaitEnd      (Phase 2 — after Admissions)
//   4 = DeadlineMiss (Phase 3)
export type EventTypePriority = 1 | 2 | 3 | 4;

// Internal run lifecycle state.
export type RunState = 'Scheduled' | 'Running' | 'Blocked' | 'Resolved';

export interface ArtifactRecord {
  key: string;
  windowIndex: number;
  publishMinute: Minute;
  attemptId: string;
  producerValid: boolean;
}

export interface WaitPolicy {
  key: string;
  requiredWindow: number;
  deadline: Minute; // inclusive Finish Cutoff
}

export interface JobDefinition {
  id: string;
  scheduledStart: Minute;
  runDuration: number; // positive integer minutes; used everywhere
  inputs: Array<{ key: string; requiredWindow: number }>;
  output?: { key: string; windowIndex: number };
  waitPolicy?: WaitPolicy;
  fallbackEnabled?: boolean;
  deduplicationEnabled?: boolean;
  // key → minute a producer is expected to publish; drives Unknown classification
  scheduledPublishMinutes?: Record<string, Minute>;
}

export interface ScenarioConfig {
  scenarioId: string;
  maxArtifactAge: number;
  jobs: JobDefinition[];
  preloadedArtifacts?: ArtifactRecord[];
}

export interface ArtifactReadRecord {
  jobId: string;
  attemptId: string;
  key: string;
  requiredWindow: number;
  actualWindowIndex: number | null;
  state: ReadState;
  publishMinute: Minute | null;
  readMinute: Minute; // immutable after creation
  artifactAge: number | null; // readMinute - publishMinute; null if Missing or Unknown
}

export interface JobRunRecord {
  jobId: string;
  attemptId: string;
  scheduledStart: Minute;
  actualStart: Minute | null;
  completionMinute: Minute | null;
  completionStatus: CompletionStatus;
  inputFreshnessStatus: InputFreshnessStatus | null;
  waitStart: Minute | null;
  waitEnd: Minute | null;
  waitOutcome: WaitOutcome | null;
  missReason: MissReason | null;
  reads: ArtifactReadRecord[];
}

export interface KeySlot {
  key: string;
  windowIndex: number;
  attemptCount: number;
  effectCount: number;
  acceptedEffectId: string | null;
  suppressedAttempts: SuppressedAttemptRecord[];
}

export interface SuppressedAttemptRecord {
  attemptId: string;
  suppressedAtMinute: Minute; // the Completion minute
  acceptedEffectId: string;
  reason: 'duplicate-output-key';
}

export interface TraceEntry {
  eventMinute: Minute;
  kind: 'StaleRead' | 'BlockedWait' | 'DeadlineMiss' | 'Suppression';
  reportId: string;
  detail: Record<string, unknown>;
}

export interface EventLogEntry {
  minute: Minute;
  typePriority: EventTypePriority;
  entityId: string;
  sortKey: string; // "MMMM:P:entityId"
  kind: string;
  payload: unknown;
}

export interface SimulationResult {
  scenarioId: string;
  runs: JobRunRecord[];
  slots: KeySlot[];
  trace: TraceEntry[];
  eventLog: EventLogEntry[];
}

export interface EvidenceBundle {
  scenarioId: string;
  runs: JobRunRecord[];
  slots: KeySlot[];
  trace: TraceEntry[];
  eventLog: EventLogEntry[];
}
