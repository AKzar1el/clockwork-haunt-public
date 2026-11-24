import type { KeySlot, SuppressedAttemptRecord, Minute } from './types.ts';

export class DedupGuard {
  private readonly _slots = new Map<string, KeySlot>();

  private slotId(key: string, windowIndex: number): string {
    return `${key}::${windowIndex}`;
  }

  getOrCreate(key: string, windowIndex: number): KeySlot {
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
   * Returns 'accepted' or 'suppressed'.
   */
  commit(
    key: string,
    windowIndex: number,
    attemptId: string,
    minute: Minute, // Completion minute
    deduplicationEnabled: boolean,
  ): 'accepted' | 'suppressed' {
    const slot = this.getOrCreate(key, windowIndex);
    slot.attemptCount += 1; // always increment first

    if (!deduplicationEnabled) {
      slot.effectCount += 1;
      return 'accepted';
    }

    if (slot.acceptedEffectId === null) {
      slot.acceptedEffectId = attemptId;
      slot.effectCount += 1;
      return 'accepted';
    }

    const rec: SuppressedAttemptRecord = {
      attemptId,
      suppressedAtMinute: minute,
      acceptedEffectId: slot.acceptedEffectId,
      reason: 'duplicate-output-key',
    };
    slot.suppressedAttempts.push(rec);
    return 'suppressed';
  }

  allSlots(): KeySlot[] {
    return Array.from(this._slots.values());
  }
}
