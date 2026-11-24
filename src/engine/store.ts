import type { ArtifactRecord } from './types.ts';

type Listener = (record: ArtifactRecord) => void;

export class ArtifactStore {
  private readonly _map = new Map<string, ArtifactRecord[]>();
  private readonly _listeners: Listener[] = [];

  add(record: ArtifactRecord): void {
    const list = this._map.get(record.key);
    if (list) {
      list.push(record);
    } else {
      this._map.set(record.key, [record]);
    }
    for (const fn of this._listeners) fn(record);
  }

  get(key: string, windowIndex: number): ArtifactRecord | undefined {
    return this._map.get(key)?.find((r) => r.windowIndex === windowIndex);
  }

  /**
   * Returns the artifact at the highest window index strictly below `windowIndex`
   * where `producerValid = true`. Returns undefined if none.
   */
  getBestBelow(key: string, windowIndex: number): ArtifactRecord | undefined {
    const list = this._map.get(key);
    if (!list) return undefined;
    let best: ArtifactRecord | undefined;
    for (const r of list) {
      if (r.windowIndex < windowIndex && r.producerValid) {
        if (best === undefined || r.windowIndex > best.windowIndex) {
          best = r;
        }
      }
    }
    return best;
  }

  getAll(key: string): ArtifactRecord[] {
    return this._map.get(key) ?? [];
  }

  onAdd(listener: Listener): void {
    this._listeners.push(listener);
  }
}
