                                             

/** Append a trace entry. Never modifies existing entries. */
export function appendTrace(log              , entry            )       {
  log.push(entry);
}
