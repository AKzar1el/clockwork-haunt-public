                                                                                           
import { ScenarioValidationError, simulate } from '../engine/simulator.js';
import { evaluatePolicyComparison } from '../fixtures/policy-comparison.js';

// Bump when simulation semantics or the generated evidence contract change.
export const replayModel = 'clockwork-minute-v6';
export const evidenceJsonDepth = 32;
                                                                                                                        

const jsonInputError = 'Replay input must use finite, acyclic JSON data within the offline depth limit.';
function checkReplayJson(input         ) {
  const active = new Set        ();
  function visit(value         , depth        )       {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))) return;
    if (typeof value !== 'object' || depth >= evidenceJsonDepth || active.has(value)) {
      throw new ScenarioValidationError(jsonInputError);
    }
    active.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item,depth+1);
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw new ScenarioValidationError(jsonInputError);
      for (const item of Object.values(value)) {
        // JSON omits undefined object properties, including optional job fields.
        if (item !== undefined) visit(item,depth+1);
      }
    }
    active.delete(value);
  }
  visit(input,1); // the evidence envelope itself occupies depth zero
}

function envelope(result                  , input                 )                    {
  return {
    schemaVersion: 1,
    replayModel,
    ...(input === undefined ? {} : { input }),
    scenarioId: result.scenarioId,
    runs: result.runs,
    slots: result.slots,
    trace: result.trace,
    eventLog: result.eventLog,
  };
}

/**
 * Build a canonical, timestamp-free evidence bundle from a simulation result.
 * Two calls on results from identical inputs produce identical JSON.
 */
export function buildEvidence(result                  , input                 )                    {
  if (input && input.scenarioId !== result.scenarioId) {
    throw new Error('Replay input scenario does not match the result.');
  }
  if (input !== undefined) checkReplayJson(input);
  return JSON.parse(JSON.stringify(envelope(result, input)));
}

/** Produce the result and its replay input from the same snapshot. */
export function evaluateReplay(input                ) {
  let snapshot                ;
  try {
    snapshot = structuredClone(input);
  } catch (error) {
    if (error instanceof Error && error.name === 'DataCloneError') throw new ScenarioValidationError(jsonInputError);
    throw error;
  }
  checkReplayJson(snapshot);
  return { input:snapshot, result:simulate(snapshot) };
}

export function evidenceFromReplay(replay                                   ) {
  return envelope(replay.result,replay.input);
}

export function buildReplayEvidence(input                ) {
  return evidenceFromReplay(evaluateReplay(input));
}

export function buildComparisonEvidence(arrival        ) {
  return evidenceFromComparison(evaluatePolicyComparison(arrival));
}

export function evidenceFromComparison(comparison                                             ) {
  const { arrival, input, onSchedule, waiting } = comparison;
  return {
    schemaVersion: 1,
    replayModel,
    kind: 'policy-comparison',
    arrival,
    runOnSchedule: envelope(onSchedule,input.fallback),
    waitForFresh: envelope(waiting,input.wait),
  };
}
