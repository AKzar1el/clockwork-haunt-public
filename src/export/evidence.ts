import type { SimulationResult, EvidenceBundle } from '../engine/types.ts';

/**
 * Build a canonical, timestamp-free evidence bundle from a simulation result.
 * Two calls on results from identical inputs produce identical JSON.
 */
export function buildEvidence(result: SimulationResult): EvidenceBundle {
  return JSON.parse(JSON.stringify({
    scenarioId: result.scenarioId,
    runs: result.runs,
    slots: result.slots,
    trace: result.trace,
    eventLog: result.eventLog,
  })) as EvidenceBundle;
}
