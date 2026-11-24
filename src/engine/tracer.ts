import type { TraceEntry } from './types.ts';

/** Append a trace entry. Never modifies existing entries. */
export function appendTrace(log: TraceEntry[], entry: TraceEntry): void {
  log.push(entry);
}
