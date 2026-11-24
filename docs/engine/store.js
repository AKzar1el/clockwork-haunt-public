                                                 

                                                 

export class ArtifactStore {
                   _map = new Map                          ();
                   _listeners             = [];

  add(record                )       {
    const list = this._map.get(record.key);
    if (list) {
      list.push(record);
    } else {
      this._map.set(record.key, [record]);
    }
    for (const fn of this._listeners) fn(record);
  }

  get(key        , windowIndex        )                             {
    return this._map.get(key)?.find((r) => r.windowIndex === windowIndex);
  }

  /**
   * Returns the artifact at the highest window index strictly below `windowIndex`
   * where `producerValid = true`. Returns undefined if none.
   */
  getBestBelow(key        , windowIndex        )                             {
    const list = this._map.get(key);
    if (!list) return undefined;
    let best                            ;
    for (const r of list) {
      if (r.windowIndex < windowIndex && r.producerValid) {
        if (best === undefined || r.windowIndex > best.windowIndex) {
          best = r;
        }
      }
    }
    return best;
  }

  getAll(key        )                   {
    return this._map.get(key) ?? [];
  }

  onAdd(listener          )       {
    this._listeners.push(listener);
  }
}
