import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable } from 'rxjs';
import { ReliveApiService, ReliveWriteRequest } from '../../core/services/relive-api.service';
import { defaultCallRule } from '../../shared/utils/relive-call-rule';
import { ReliveCycle, Step } from '../../shared/utils/relive-types';

/** Strips the server-assigned fields so a draft can be sent back as a write request. */
function toWritable(cycle: ReliveCycle): ReliveWriteRequest {
  const { id, createdAt, updatedAt, transient, lastRun, ...rest } = cycle;
  return rest;
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

  readonly dirty = computed(() => {
    const saved = this.saved();
    const draft = this.draft();
    if (!saved || !draft) return false;
    return JSON.stringify(toWritable(saved)) !== JSON.stringify(toWritable(draft));
  });

  load(id: string): void {
    this.api.get(id).subscribe((cycle) => {
      this.saved.set(cycle);
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
    const saved = this.saved();
    const draft = this.draft();
    if (!saved || !draft || this.saving()) return;
    this.saving.set(true);
    this.api.update(saved.id, toWritable(draft), saved.updatedAt ?? '', reason).subscribe({
      next: (updated) => {
        this.saved.set(updated);
        this.draft.set(updated);
        this.conflict.set(null);
        this.saving.set(false);
      },
      error: (err) => {
        this.saving.set(false);
        if (err?.status === 409) {
          this.api.get(saved.id).subscribe((latest) => this.conflict.set(latest));
        }
      },
    });
  }

  /** "Reload" from the reload-prompt: replaces the draft with what's actually on the server,
   *  discarding the local edits that conflicted. */
  reloadFromConflict(): void {
    const latest = this.conflict();
    if (!latest) return;
    this.saved.set(latest);
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

  /** Duplicates the whole saved cycle via the API (FR-007) - a fresh cycle with its own id,
   *  independent of this one's unsaved draft. */
  duplicateCycle(): Observable<ReliveCycle> | null {
    const saved = this.saved();
    if (!saved) return null;
    return this.api.duplicate(saved.id);
  }
}
