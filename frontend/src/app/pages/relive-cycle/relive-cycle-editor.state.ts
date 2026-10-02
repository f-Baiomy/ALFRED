import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Observable } from 'rxjs';
import { ReliveApiService, ReliveWriteRequest } from '../../core/services/relive-api.service';
import { defaultCallRule } from '../../shared/utils/relive-call-rule';
import { ExternalReachEntry, externalReach, newlyReaching } from '../../shared/utils/relive-external-reach';
import { CycleVersion, ReliveCycle, Step } from '../../shared/utils/relive-types';

/** How long the "Rebuild applied · Undo" toast (T070) stays up before the offer expires. */
const REBUILD_UNDO_MS = 8000;

/** One "this can now reach a real system" notice (FR-015a) - `undoSnapshot` is the draft exactly
 *  as it was before the change that raised it, so Undo can restore it verbatim. */
export interface ExternalNotice {
  readonly id: string;
  readonly items: readonly ExternalReachEntry[];
  readonly undoSnapshot: ReliveCycle;
}

/** Strips the server-assigned fields so a draft can be sent back as a write request. */
function toWritable(cycle: ReliveCycle): ReliveWriteRequest {
  const { id, createdAt, updatedAt, transient, lastRun, ...rest } = cycle;
  return rest;
}

/** Same JSON, short-circuiting on shared references: an edit replaces only the objects it changes,
 *  so a 200-step cycle compares one step's text, not every recorded body, per keystroke (review P4). */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameJson(item, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left).filter((k) => left[k] !== undefined);
    if (keys.length !== Object.keys(right).filter((k) => right[k] !== undefined).length) return false;
    return keys.every((k) => sameJson(left[k], right[k]));
  }
  return false;
}

/**
 * Component-provided (one instance per open cycle page) - `saved` is the last definition the
 * backend confirmed, `draft` is what the user is editing; `dirty` compares the two so Save can
 * enable/disable itself and the unsaved-changes guard (FR-008) knows whether to ask before
 * leaving. A 409 on save (someone else changed the cycle first) sets `conflict` to the server's
 * current definition rather than overwriting it - the caller shows "changed elsewhere, reload?"
 * and calls `reloadFromConflict()`/`discardConflict()`.
 */
@Injectable()
export class ReliveCycleEditorState {
  private readonly api = inject(ReliveApiService);

  readonly saved = signal<ReliveCycle | null>(null);
  readonly draft = signal<ReliveCycle | null>(null);
  readonly selectedStepKey = signal<string | null>(null);
  readonly conflict = signal<ReliveCycle | null>(null);
  readonly saving = signal(false);
  readonly saveError = signal<string | null>(null);
  readonly notices = signal<readonly ExternalNotice[]>([]);

  /** The last draft the watcher effect saw, and what it could reach - "previous" for the next
   *  comparison. Plain fields, not signals: reading them inside the effect must never make the
   *  effect depend on them, only on `draft()`. */
  private previousDraft: ReliveCycle | null = null;
  private previousReach: ReadonlyMap<string, ExternalReachEntry> = new Map();
  /** Set right before a load/reset/rebuild-style replacement of the whole draft, so the watcher
   *  updates its baseline without raising a notice for it (FR-015a: "no setup noise"). */
  private quietOnce = false;

  constructor() {
    effect(() => {
      const draft = this.draft();
      if (!draft) {
        this.previousDraft = null;
        this.previousReach = new Map();
        return;
      }
      const reach = externalReach(draft);
      if (!this.quietOnce && this.previousDraft) {
        const freshKeys = newlyReaching(this.previousReach, reach);
        if (freshKeys.length) {
          const items = freshKeys.map((key) => reach.get(key)!);
          this.notices.update((list) => [...list, { id: crypto.randomUUID(), items, undoSnapshot: this.previousDraft! }]);
        }
      }
      this.quietOnce = false;
      this.previousDraft = draft;
      this.previousReach = reach;
    }, { allowSignalWrites: true });
  }

  readonly dirty = computed(() => {
    const saved = this.saved();
    const draft = this.draft();
    if (!saved || !draft) return false;
    return !sameJson(toWritable(saved), toWritable(draft));
  });

  load(id: string): void {
    this.api.get(id).subscribe((cycle) => {
      this.saved.set(cycle);
      this.quietOnce = true;
      this.draft.set(cycle);
      this.conflict.set(null);
    });
  }

  /** Applies `mutator` to the current draft - the one place every editing control in the cycle
   *  page goes through, so `dirty` always reflects every change. */
  update(mutator: (draft: ReliveCycle) => ReliveCycle): void {
    const current = this.draft();
    if (!current) return;
    this.draft.set(mutator(current));
  }

  save(reason?: string): void {
    void this.saveAsync(reason).catch(() => undefined);
  }

  saveAsync(reason?: string): Promise<ReliveCycle> {
    const saved = this.saved();
    const draft = this.draft();
    if (!saved || !draft || this.saving()) return Promise.reject(new Error('Cycle is not ready to save.'));
    this.saving.set(true);
    this.saveError.set(null);
    return new Promise((resolve, reject) => {
      this.api.update(saved.id, toWritable(draft), saved.updatedAt ?? '', reason).subscribe({
        next: (updated) => {
          this.saved.set(updated);
          this.quietOnce = true;
          this.draft.set(updated);
          this.conflict.set(null);
          this.saving.set(false);
          resolve(updated);
        },
        error: (err) => {
          this.saving.set(false);
          const serverMessage = typeof err?.error?.error === 'string' ? err.error.error : null;
          this.saveError.set(err?.status === 409
            ? 'Cycle changed elsewhere. Resolve the conflict before running.'
            : serverMessage ?? 'Could not save this cycle. Try again.');
          if (err?.status === 409) this.api.get(saved.id).subscribe((latest) => this.conflict.set(latest));
          reject(err);
        },
      });
    });
  }

  /** "Reload" from the reload-prompt: replaces the draft with what's actually on the server,
   *  discarding the local edits that conflicted. */
  reloadFromConflict(): void {
    const latest = this.conflict();
    if (!latest) return;
    this.saved.set(latest);
    this.quietOnce = true;
    this.draft.set(latest);
    this.conflict.set(null);
  }

  discardConflict(): void {
    this.conflict.set(null);
  }

  /** Rebuilds one step's call rule from its recording and the cycle's current settings, undoing
   *  every edit made to it (actions, mock data, pauses, conditions, the match) - FR-006/FR-010b.
   *  Everything else about the step (label, optional, extract/assertions) is untouched. */
  resetStep(key: string): void {
    this.quietOnce = true;
    this.update((draft) => ({
      ...draft,
      steps: draft.steps.map((s) =>
        s.key === key ? { ...s, callRule: defaultCallRule(s, draft.settings), unattributed: 'BLOCK' } : s,
      ),
    }));
  }

  /** "Reset to recording" - every step's call rule back to its default, every step re-enabled
   *  (FR-007). */
  resetCycle(): void {
    this.quietOnce = true;
    this.update((draft) => ({
      ...draft,
      steps: draft.steps.map((s) => ({ ...s, callRule: defaultCallRule(s, draft.settings), unattributed: 'BLOCK', enabled: true })),
    }));
  }

  /** Duplicates one step (and its children, if it's an inbound one) with fresh keys, right after
   *  the original block (FR-007). */
  duplicateStep(key: string): void {
    this.update((draft) => {
      const original = draft.steps.find((s) => s.key === key);
      if (!original) return draft;
      const newKey = crypto.randomUUID();
      const copy: Step = { ...original, key: newKey, label: original.label + ' (2)' };
      const childCopies = draft.steps.filter((s) => s.parentKey === key).map((c) => ({ ...c, key: crypto.randomUUID(), parentKey: newKey }));
      const insertAt = draft.steps.findIndex((s) => s.key === key) + 1 + draft.steps.filter((s) => s.parentKey === key).length;
      const steps = [...draft.steps];
      steps.splice(insertAt, 0, copy, ...childCopies);
      return { ...draft, steps };
    });
  }

  dismissNotice(id: string): void {
    this.notices.update((list) => list.filter((n) => n.id !== id));
  }

  /** "↶ Undo" on a notice: restores the draft to what it was right before the change that raised
   *  it, quietly (no new notice for undoing). */
  undoNotice(id: string): void {
    const notice = this.notices().find((n) => n.id === id);
    if (!notice) return;
    this.quietOnce = true;
    this.draft.set(notice.undoSnapshot);
    this.dismissNotice(id);
  }

  /** Duplicates the whole saved cycle via the API (FR-007) - a fresh cycle with its own id,
   *  independent of this one's unsaved draft. */
  duplicateCycle(): Observable<ReliveCycle> | null {
    const saved = this.saved();
    if (!saved) return null;
    return this.api.duplicate(saved.id);
  }

  // ---- T070: rebuild ----

  readonly rebuilding = signal(false);
  /** The version the pre-rebuild definition was snapshotted as - offered for 8s as "Undo". */
  readonly rebuildUndo = signal<{ readonly version: number } | null>(null);
  private rebuildUndoTimer?: ReturnType<typeof setTimeout>;

  /** Replaces the SAVED cycle's steps with `newSteps` and persists immediately (bypassing the
   *  draft), snapshotting the previous definition as a version tagged `reason` first - the rebuild
   *  dialog's three modes (FR-US6b) and "Replace steps of cycle…" (T071) share this. Requires a
   *  clean draft: the caller must confirm/discard local edits before calling this. */
  rebuild(newSteps: readonly Step[], reason: CycleVersion['reason']): void {
    const saved = this.saved();
    if (!saved || this.saving() || this.rebuilding()) return;
    this.rebuilding.set(true);
    this.api.update(saved.id, toWritable({ ...saved, steps: newSteps }), saved.updatedAt ?? '', reason).subscribe({
      next: (updated) => {
        this.saved.set(updated);
        this.quietOnce = true;
        this.draft.set(updated);
        this.rebuilding.set(false);
        this.api.listVersions(saved.id).subscribe((versions) => {
          const latest = versions.reduce((max, v) => (!max || v.version > max.version ? v : max), null as CycleVersion | null);
          if (latest) this.pushRebuildUndo(latest.version);
        });
      },
      error: () => this.rebuilding.set(false),
    });
  }

  private pushRebuildUndo(version: number): void {
    clearTimeout(this.rebuildUndoTimer);
    this.rebuildUndo.set({ version });
    this.rebuildUndoTimer = setTimeout(() => this.rebuildUndo.set(null), REBUILD_UNDO_MS);
  }

  /** "Undo" on the rebuild toast: restores the cycle to the version snapshotted just before the
   *  rebuild was applied. */
  undoRebuild(): void {
    const saved = this.saved();
    const undo = this.rebuildUndo();
    if (!saved || !undo) return;
    clearTimeout(this.rebuildUndoTimer);
    this.rebuildUndo.set(null);
    this.api.restoreVersion(saved.id, undo.version).subscribe((restored) => {
      this.saved.set(restored);
      this.quietOnce = true;
      this.draft.set(restored);
    });
  }
}
