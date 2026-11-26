                                                 

                                                 
                                                                           
                                                                                                                       
                       
                        
                                      
                            
                                 
                                                                                     
  
const indexThreshold = 8;

function lowerBound(windows          , target        )         {
  let lo = 0;
  let hi = windows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (windows[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function publicationBound(records                  , minute        , inclusive         )         {
  let lo = 0;
  let hi = records.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const publish = records[mid].publishMinute;
    if (publish < minute || (inclusive && publish === minute)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function buildAttemptIndex(records                  )               {
  const valid = new Map                        ();
  const invalid = new Map                        ();
  for (const record of records) {
    const group = record.producerValid ? valid : invalid;
    const prior = group.get(record.publishMinute);
    if (!prior || record.attemptId < prior.attemptId) group.set(record.publishMinute, record);
  }
  const sorted = (group                             ) =>
    [...group.values()].sort((a, b) => a.publishMinute - b.publishMinute);
  return { valid: sorted(valid), invalid: sorted(invalid) };
}

function indexAttempt(index              , record                ) {
  const records = record.producerValid ? index.valid : index.invalid;
  const last = records[records.length - 1];
  // As the simulation clock advances, most new attempts belong at the tail.
  if (!last || last.publishMinute < record.publishMinute) {
    records.push(record);
    return;
  }
  if (last.publishMinute === record.publishMinute) {
    if (record.attemptId < last.attemptId) records[records.length - 1] = record;
    return;
  }
  const position = publicationBound(records, record.publishMinute, false);
  const prior = records[position];
  if (prior?.publishMinute === record.publishMinute) {
    if (record.attemptId < prior.attemptId) records[position] = record;
  } else records.splice(position, 0, record);
}

export class ArtifactStore {
                   _map = new Map                        ();
                   _listeners             = [];

  add(record                )       {
    const stored = Object.freeze({ ...record });
    let bucket = this._map.get(stored.key);
    if (!bucket) {
      bucket = { all: [], byWindow: new Map() };
      this._map.set(stored.key, bucket);
    }
    bucket.all.push(stored);
    if (bucket.lastFallback) bucket.lastFallback = undefined;
    const window = bucket.byWindow.get(stored.windowIndex);
    const indexable = Number.isFinite(stored.publishMinute);
    const validMinute = stored.producerValid
      ? (Number.isNaN(stored.publishMinute) ? -Infinity : stored.publishMinute) : undefined;
    if (validMinute !== undefined && !Number.isNaN(stored.windowIndex) &&
        (bucket.firstValidMinute === undefined || validMinute < bucket.firstValidMinute)) {
      bucket.firstValidMinute = validMinute;
    }
    if (validMinute !== undefined && window?.firstValidMinute === undefined &&
        bucket.orderedValidWindows && !Number.isNaN(stored.windowIndex)) {
      const windows = bucket.orderedValidWindows;
      windows.splice(lowerBound(windows, stored.windowIndex), 0, stored.windowIndex);
    }
    if (window) {
      window.records.push(stored);
      if (validMinute !== undefined &&
          (window.firstValidMinute === undefined || validMinute < window.firstValidMinute)) {
        window.firstValidMinute = validMinute;
      }
      if (!indexable) {
        window.indexable = false;
        window.index = undefined;
      } else if (window.index) indexAttempt(window.index, stored);
    } else {
      bucket.byWindow.set(stored.windowIndex, { records: [stored], indexable, firstValidMinute: validMinute });
    }
    for (const fn of this._listeners) fn(stored);
  }

  get(key        , windowIndex        , atMinute = Infinity)                             {
    const window = this._map.get(key)?.byWindow.get(windowIndex);
    if (!window) return undefined;
    if (window.indexable && window.records.length > indexThreshold && !Number.isNaN(atMinute)) {
      const { valid, invalid } = window.index ??= buildAttemptIndex(window.records);
      return valid[publicationBound(valid, atMinute, true) - 1] ??
        invalid[publicationBound(invalid, atMinute, true) - 1];
    }
    let best                            ;
    for (const record of window.records) {
      if (record.publishMinute > atMinute) continue;
      if (!best || (record.producerValid && !best.producerValid) ||
        (record.producerValid === best.producerValid &&
          (record.publishMinute > best.publishMinute ||
            (record.publishMinute === best.publishMinute && record.attemptId < best.attemptId)))) best = record;
    }
    return best;
  }

  /**
   * Returns the artifact at the highest window index strictly below `windowIndex`
   * where `producerValid = true`. Returns undefined if none.
   */
  getBestBelow(key        , windowIndex        , atMinute = Infinity)                             {
    const bucket = this._map.get(key);
    // No window can be a fallback before this key's earliest valid publication.
    if (!bucket || bucket.firstValidMinute === undefined || bucket.firstValidMinute > atMinute) return undefined;
    // Same-minute consumers can share the choice, never each other's read record.
    const cached = bucket.lastFallback;
    if (cached?.window === windowIndex && cached.minute === atMinute) return cached.result;
    let windows = bucket.orderedValidWindows;
    if (!windows) {
      windows = [];
      for (const [window, attempts] of bucket.byWindow) {
        if (attempts.firstValidMinute !== undefined && !Number.isNaN(window)) windows.push(window);
      }
      windows.sort((a, b) => a - b);
      bucket.orderedValidWindows = windows;
    }
    let result                            ;
    for (let i = lowerBound(windows, windowIndex) - 1; i >= 0; i--) {
      if (bucket.byWindow.get(windows[i]) .firstValidMinute  > atMinute) continue;
      const best = this.get(key, windows[i], atMinute);
      if (best?.producerValid) {
        result = best;
        break;
      }
    }
    bucket.lastFallback = {window:windowIndex,minute:atMinute,result};
    return result;
  }

  getAll(key        )                   {
    return this._map.get(key)?.all.slice() ?? [];
  }

  onAdd(listener          )       {
    this._listeners.push(listener);
  }
}
