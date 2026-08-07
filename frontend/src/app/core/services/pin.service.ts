import { Injectable, signal } from '@angular/core';
import { CallRecord } from '../models/call.model';
import { callKey } from '../../shared/utils/call-utils';

const STORAGE_KEY = 'alfred_pinned_calls';

function loadFromStorage(): ReadonlyMap<string, CallRecord> {
  try {
    const stored: CallRecord[] = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return new Map(stored.map((c) => [callKey(c), c]));
  } catch {
    return new Map();
  }
}

function saveToStorage(map: ReadonlyMap<string, CallRecord>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...map.values()]));
  } catch {
    // storage full/blocked - pins just won't survive a reload this time
  }
}

/**
 * Pinned calls are cached in full (not just their id) because a pinned call
 * can scroll out of the backend's last-N window entirely once enough new
 * traffic arrives - the id alone wouldn't be enough to keep showing it.
 */
@Injectable({ providedIn: 'root' })
export class PinService {
  private readonly _pinned = signal<ReadonlyMap<string, CallRecord>>(loadFromStorage());
  readonly pinned = this._pinned.asReadonly();

  isPinned(call: CallRecord): boolean {
    return this._pinned().has(callKey(call));
  }

  toggle(call: CallRecord): void {
    const id = callKey(call);
    const next = new Map(this._pinned());
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.set(id, call);
    }
    this._pinned.set(next);
    saveToStorage(next);
  }
}
