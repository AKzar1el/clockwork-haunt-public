                                                                   

/** Build the canonical sort key string "MMMM:P:entityId". */
export function sortKey(
  minute        ,
  typePriority                   ,
  entityId        ,
)         {
  return `${String(minute).padStart(4, '0')}:${typePriority}:${entityId}`;
}

/**
 * Compare two event log entries by their sort key.
 * Throws a configuration error if two entries share the same (minute, typePriority, entityId).
 */
export function compareEntries(
  a                                                                         ,
  b                                                                         ,
)         {
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
}
