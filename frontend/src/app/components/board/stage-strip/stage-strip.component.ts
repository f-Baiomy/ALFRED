import { Component, computed, input } from '@angular/core';
import { BoardStage } from '../../../core/models/board.models';
import { SyncResult } from '../../../core/team/team.models';
import { PHASES } from '../../../shared/utils/task-view';

/** The seven stages of a task (specs/030 FR-013); the first, Board, is done once the board exists. */
export const STAGES = [
  { key: 'BOARD', label: 'Board', hint: 'Made in the UI - nothing runs by itself' },
  { key: 'DEFINE', label: 'Define', hint: 'Brief, requirements, test steps and the cards - Claude drafts them, you save' },
  { key: 'TRIAGE', label: 'Triage', hint: 'Each new card: yours, another team\'s, or fine - decided with you' },
  { key: 'CODE', label: 'Code', hint: 'The fixes - Claude after your Go, or you' },
  { key: 'VERIFY', label: 'Verify', hint: 'Each fix checked in the code and in the calls' },
  { key: 'TEST', label: 'Test', hint: 'Record while you use the app; the calls tick the requirements' },
  { key: 'CLOSE', label: 'Close', hint: 'The summary and one update for the work item' },
] as const;

const PHASE_TIPS: Record<string, string> = {
  Coded: 'the change is in', Verifying: 'calls checked against the requirements', Fixed: 'the bugs found were fixed',
  'Re-tested': 'the fixes checked again', Done: 'every requirement met and marked by you',
};

/** The ladder shows once there is code to judge (specs/032 D3). */
const LADDER_FROM = ['CODE', 'VERIFY', 'TEST', 'CLOSE'];

/** One line for what a refresh found: "3 changes · 1 new in the tree · 1 possible match". */
export function refreshLine(r: SyncResult): string {
  const parts: string[] = [];
  const changed = r.changedItems?.length ?? r.changed;
  if (changed) parts.push(`${changed} changed`);
  const comments = (r.changedItems ?? []).reduce((n, i) => n + i.newComments, 0);
  if (comments) parts.push(`${comments} new comment${comments === 1 ? '' : 's'}`);
  if (r.newInTree) parts.push(`${r.newInTree} new in the tree (in Incoming)`);
  if (r.leftTree) parts.push(`${r.leftTree} left the tree`);
  if (r.matches) parts.push(`${r.matches} possible card match${r.matches === 1 ? '' : 'es'}`);
  return parts.length ? parts.join(' · ') : 'No changes in Azure';
}

/**
 * The stage line (specs/032 D1/D3): the seven stages as circles joined by lines - done ones ✓ green, the current one
 * filled with its number - and, from Code on, the Coded → Done ladder on the right. Only shows where the task stands:
 * the next step and its buttons are the Next card's (`BoardStage.of` decides both, once).
 */
@Component({
  selector: 'app-stage-strip',
  standalone: true,
  styles: [`
    .stages { display: flex; align-items: center; flex-wrap: wrap; row-gap: 8px; margin: 4px 0 12px; }
    .stg { display: flex; align-items: center; gap: 7px; padding: 2px 4px; font-size: 12.5px; color: var(--text-faint); cursor: default; }
    .stg i { display: inline-grid; place-items: center; width: 21px; height: 21px; border-radius: 50%; border: 1px solid var(--border-strong);
      font-style: normal; font-size: 11px; }
    .stg.done { color: var(--text-dim); }
    .stg.done i { background: color-mix(in srgb, var(--green) 18%, transparent); border-color: color-mix(in srgb, var(--green) 50%, transparent); color: var(--green); }
    .stg.now { color: var(--text); font-weight: 600; }
    .stg.now i { background: var(--purple); border-color: var(--purple); color: #fff; }
    .line { flex: 1; height: 1px; min-width: 12px; max-width: 54px; background: var(--border); }
    .line.done { background: color-mix(in srgb, var(--green) 45%, transparent); }
    .spacer { flex: 1; }
    .ladder { display: flex; gap: 6px; align-items: center; margin-left: 16px; font-size: 12px; }
    .ladder span { padding: 2px 9px; border: 1px solid var(--border); border-radius: 999px; color: var(--text-faint); white-space: nowrap; }
    .ladder .done { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); }
    .ladder .now { color: #111; background: var(--amber); border-color: var(--amber); font-weight: 700; }
    @media (max-width: 760px) { .ladder { margin-left: 0; } .spacer { flex-basis: 100%; } }
  `],
  template: `
    @if (stage(); as st) {
      <div class="stages" role="list" aria-label="Where the task stands">
        @for (s of stages; track s.key; let i = $index) {
          @if (i) { <span class="line" [class.done]="i <= at()" aria-hidden="true"></span> }
          <span role="listitem" class="stg" [class.done]="i < at()" [class.now]="i === at()" [title]="s.label + ': ' + s.hint"
                [attr.aria-current]="i === at() ? 'step' : null"><i>{{ i < at() ? '✓' : i + 1 }}</i>{{ s.label }}</span>
        }
        @if (ladder()) {
          <span class="spacer"></span>
          <span class="ladder" title="Does the code match the task?" aria-label="Does the code match the task?">
            @for (ph of phases; track ph; let i = $index) {
              <span [class.done]="i < phase()!" [class.now]="i === phase()" [title]="ph + ': ' + tips[ph]">{{ i < phase()! ? '✓ ' : '' }}{{ ph }}</span>
            }
          </span>
        }
      </div>
    }`,
})
export class StageStripComponent {
  readonly stage = input<BoardStage | null>(null);
  /** 0 Coded … 4 Done (`phaseOf`, from the task's requirements and cards); null while not known. */
  readonly phase = input<number | null>(null);

  readonly stages = STAGES;
  readonly phases = PHASES;
  readonly tips = PHASE_TIPS;
  readonly at = computed(() => {
    const st = this.stage();
    return st ? Math.max(1, this.stages.findIndex((s) => s.key === st.stage)) : 0;
  });
  readonly ladder = computed(() => this.phase() !== null && LADDER_FROM.includes(this.stage()?.stage ?? ''));
}
