import { CdkDrag, CdkDragDrop, CdkDragHandle, CdkDropList, moveItemInArray } from '@angular/cdk/drag-drop';
import { NgTemplateOutlet } from '@angular/common';
import { Component, TemplateRef, computed, input, output, signal } from '@angular/core';
import { ReliveStepCallComponent } from '../relive-step-call/relive-step-call.component';
import { applyMode, checkpointOf, isModified, modeOf } from '../../shared/utils/relive-call-rule';
import { ReliveSettings, Step, StepMode } from '../../shared/utils/relive-types';

/** One inbound step plus its outbound children, in their current relative order - the unit a
 *  drag reorders as a whole (mock.html `bindDnD()`/`moveBefore()`). */
export interface StepBlock {
  readonly parent: Step;
  readonly children: readonly Step[];
}

export function toBlocks(steps: readonly Step[]): StepBlock[] {
  const tops = steps.filter((s) => !s.parentKey);
  return tops.map((parent) => ({ parent, children: steps.filter((s) => s.parentKey === parent.key) }));
}

function flattenBlocks(blocks: readonly StepBlock[]): Step[] {
  return blocks.flatMap((b) => [b.parent, ...b.children]);
}

/** Pure reorder: moves the top-level block at `fromIndex` to `toIndex`, its children included,
 *  and leaves everything else's relative order untouched. */
export function reorderTopLevel(steps: readonly Step[], fromIndex: number, toIndex: number): Step[] {
  const blocks = toBlocks(steps);
  moveItemInArray(blocks, fromIndex, toIndex);
  return flattenBlocks(blocks);
}

/**
 * The step tree (FR-005, FR-010a; mock.html `stepsPanel()`/`stepRow()`/`childRow()`): inbound
 * rows in order, each with its outbound children indented below it, mode buttons per child,
 * drag-to-reorder (whole block), fold/search, and per-row badges.
 */
@Component({
  selector: 'app-relive-step-tree',
  standalone: true,
  imports: [CdkDropList, CdkDrag, CdkDragHandle, NgTemplateOutlet, ReliveStepCallComponent],
  templateUrl: './relive-step-tree.component.html',
})
export class ReliveStepTreeComponent {
  readonly steps = input.required<readonly Step[]>();
  readonly settings = input.required<ReliveSettings>();
  readonly selectedKey = input<string | null>(null);
  /** What opens under the selected step - the host's call card with its step panel. Defaults to the bare card. */
  readonly detail = input<TemplateRef<{ $implicit: Step }> | null>(null);

  readonly stepsChange = output<readonly Step[]>();
  /** Not `select` - see CallStepStripComponent.stepSelect: double-clicking a word in a field of the
   *  open step fired the native `select` event, which closed the step. */
  readonly stepSelect = output<string>();
  readonly addCallsRequested = output<void>();

  readonly search = signal('');
  readonly folded = signal<ReadonlySet<string>>(new Set());

  readonly blocks = computed(() => {
    const q = this.search().trim().toLowerCase();
    const all = toBlocks(this.steps());
    if (!q) return all;
    return all.filter((b) => b.parent.label.toLowerCase().includes(q) || b.children.some((c) => c.label.toLowerCase().includes(q)));
  });

  isFolded(key: string): boolean {
    return this.folded().has(key);
  }

  toggleFold(key: string, event: Event): void {
    event.stopPropagation();
    const next = new Set(this.folded());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.folded.set(next);
  }

  onSearch(value: string): void {
    this.search.set(value);
  }

  onSelect(key: string): void {
    this.stepSelect.emit(key);
  }

  pathOf(step: Step): string {
    try {
      const url = new URL(step.recording.url);
      return url.pathname + url.search;
    } catch {
      return step.recording.url;
    }
  }

  modeOf(step: Step): StepMode {
    return modeOf(step.callRule);
  }

  hasCheckpoint(step: Step): boolean {
    const cp = checkpointOf(step.callRule);
    return cp.before || cp.after;
  }

  isRuleModified(step: Step): boolean {
    return isModified(step.callRule, step, this.settings());
  }

  setMode(step: Step, mode: StepMode, event: Event): void {
    event.stopPropagation();
    if (this.modeOf(step) === mode) return;
    const updated: Step = { ...step, callRule: applyMode(step.callRule, mode, step.recording) };
    this.stepsChange.emit(this.steps().map((s) => (s.key === step.key ? updated : s)));
  }

  toggleEnabled(step: Step, event: Event): void {
    event.stopPropagation();
    const nextEnabled = !step.enabled;
    this.stepsChange.emit(
      this.steps().map((s) => {
        if (s.key === step.key) return { ...s, enabled: nextEnabled };
        if (s.parentKey === step.key) return { ...s, enabled: nextEnabled };
        return s;
      }),
    );
  }

  remove(step: Step, event: Event): void {
    event.stopPropagation();
    this.stepsChange.emit(this.steps().filter((s) => s.key !== step.key && s.parentKey !== step.key));
  }

  duplicate(step: Step, event: Event): void {
    event.stopPropagation();
    const newParentKey = crypto.randomUUID();
    const parentCopy: Step = { ...step, key: newParentKey, label: step.label + ' (2)' };
    const childCopies = this.steps()
      .filter((s) => s.parentKey === step.key)
      .map((c) => ({ ...c, key: crypto.randomUUID(), parentKey: newParentKey }));
    const all = [...this.steps()];
    const insertAt = all.findIndex((s) => s.key === step.key) + 1 + all.filter((s) => s.parentKey === step.key).length;
    all.splice(insertAt, 0, parentCopy, ...childCopies);
    this.stepsChange.emit(all);
  }

  onBlockDropped(event: CdkDragDrop<unknown>): void {
    if (event.previousIndex === event.currentIndex) return;
    this.stepsChange.emit(reorderTopLevel(this.steps(), event.previousIndex, event.currentIndex));
  }
}
