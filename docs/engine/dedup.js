                                                                           

export class DedupGuard {
                   _slots = new Map                 ();

          slotId(key        , windowIndex        )         {
    return `${key}::${windowIndex}`;
  }

          getOrCreate(key        , windowIndex        )          {
    const id = this.slotId(key, windowIndex);
    let slot = this._slots.get(id);
    if (!slot) {
      slot = { key, windowIndex, attemptCount: 0, effectCount: 0, acceptedEffectId: null, suppressedAttempts: [] };
      this._slots.set(id, slot);
    }
    return slot;
  }

  /**
   * Register a commit attempt. attemptCount increments before the suppression
   * check in all cases (AC-034).
   * Returns the recorded suppression, or null when accepted.
   */
  commit(
    key        ,
    windowIndex        ,
    attemptId        ,
    minute        , // Completion minute
    deduplicationEnabled         ,
  )                                 {
    const slot = this.getOrCreate(key, windowIndex);
    slot.attemptCount += 1; // always increment first

    if (!deduplicationEnabled) {
      slot.effectCount += 1;
      return null;
    }

    if (slot.acceptedEffectId === null) {
      slot.acceptedEffectId = attemptId;
      slot.effectCount += 1;
      return null;
    }

    const rec                          = {
      attemptId,
      suppressedAtMinute: minute,
      acceptedEffectId: slot.acceptedEffectId,
      reason: 'duplicate-output-key',
    };
    slot.suppressedAttempts.push(rec);
    return rec;
  }

  allSlots()            {
    return Array.from(this._slots.values());
  }
}
