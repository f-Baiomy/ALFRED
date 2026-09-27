import { CdkDrag, CdkDragDrop, CdkDragHandle, CdkDropList } from '@angular/cdk/drag-drop';
import { KeyValuePipe } from '@angular/common';
import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { forkJoin, map, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { CallRecord } from '../../core/models/call.model';
import { directionOf } from '../../core/models/call-ref.model';
import { BulkResendDialogService, DraftResult } from '../../core/services/bulk-resend-dialog.service';
import { CallPickerService } from '../../core/services/call-picker.service';
import { CallRefDetailService } from '../../core/services/call-ref-detail.service';
import { CallsApiService } from '../../core/services/calls-api.service';
import { buildMatcher, literalReplacement, matcherError } from '../../shared/utils/find-replace';
import { parseDatasetText } from '../../shared/utils/resend-draft-dataset';
import {
  Dataset,
  Assertion,
  ExtractRule,
  ResendDraft,
  RetryPolicy,
  countMatches,
  describeEdits,
  draftFrom,
  findReplaceAll,
  isEdited,
  removeHeaderFromAll,
  resetDraft,
  setCurrentSessionOnAll,
  setHeaderOnAll,
  setHostOnAll,
  setMethodOnAll,
} from '../../shared/utils/resend-draft';
import {
  GroupMode,
  ResendGroup,
  SendRun,
  addMemberAt,
  addToGroup,
  draftsInGroup,
  extractToRun,
  groupDrafts,
  newGroupId,
  nextGroupName,
  pruneGroups,
  runAtOffset,
  swapMembers,
  swapRuns,
  ungroup,
} from '../../shared/utils/resend-group';
import { ResendCallEditorComponent } from '../resend-call-editor/resend-call-editor.component';
import { ResendPanelComponent } from '../resend-panel/resend-panel.component';
import { ScenarioAssertionEditorComponent } from '../scenario-assertion-editor/scenario-assertion-editor.component';

const PICK_REQUESTER = 'bulk-resend';

/** The outer drop list's DOM id, referenced by every group's list so a member can be dragged out. */
const OUTER_LIST = 'br-resend-list';

/**
 * What a drag carries, so a drop knows what it is holding without inferring it from indices: a
 * single call (loose or a group member) or a whole group.
 */
type DragPayload =
  | { readonly kind: 'call'; readonly draft: ResendDraft }
  | { readonly kind: 'group'; readonly groupId: string };

/**
 * The multi-call resend editor behind "Resend selected…": the calls in send order (drag, arrows,
 * untick to skip), each fully editable on its own, tools that edit a whole scope at once, and the
 * send itself.
 *
 * The list is a sequence of RUNS (resend-group.ts) - a named group, or a stretch of loose calls
 * between two groups. Runs go in list order; a group moves and is sent as one block, and only
 * inside a parallel group do its calls overlap. Grouping is free-form to create and contiguous to
 * live, so grouping the calls at 1, 4 and 7 makes them 1, 2, 3 and shifts the rest up.
 *
 * State lives in BulkResendDialogService so it survives this dialog hiding while "Add calls from
 * anywhere…" sends the user to other tabs, and so a send keeps going if the dialog is closed.
 * Mounted once, in the main layout.
 */
@Component({
  selector: 'app-bulk-resend-dialog',
  standalone: true,
  imports: [CdkDropList, CdkDrag, CdkDragHandle, KeyValuePipe, ResendCallEditorComponent, ResendPanelComponent, ScenarioAssertionEditorComponent],
  templateUrl: './bulk-resend-dialog.component.html',
})
export class BulkResendDialogComponent {
  readonly service = inject(BulkResendDialogService);
  private readonly picker = inject(CallPickerService);
  private readonly refDetail = inject(CallRefDetailService);
  private readonly callsApi = inject(CallsApiService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly mode = signal<'call' | 'all'>('call');
  readonly selectedKey = signal<string | null>(null);
  readonly stopOnFailure = this.service.stopOnFailure;
  readonly delayMs = this.service.delayMs;
  readonly notice = signal<string | null>(null);

  // Edit all at once
  readonly headerName = signal('');
  readonly headerValue = signal('');
  readonly find = signal('');
  readonly replace = signal('');
  readonly regex = signal(false);
  readonly matchCase = signal(false);
  readonly inUrl = signal(true);
  readonly inHeaders = signal(true);
  readonly inBody = signal(true);
  readonly method = signal('');
  readonly host = signal('');

  // C1: a new "Pass on" row being drafted for the selected call.
  readonly extractFrom = signal<ExtractRule['from']>('JSON');
  readonly extractPath = signal('');
  readonly extractAs = signal('');
  readonly extractMissing = signal<ExtractRule['missing']>('SKIP');
  readonly extractFallback = signal('');

  // D3: retry policy and parallel cap, applied to the whole resend.
  readonly retryAttempts = signal(0);
  readonly retryBackoffMs = signal(1000);
  readonly retryOn5xx = signal(true);
  readonly retryOnNetwork = signal(true);
  readonly maxParallelInput = signal('');

  // D3: dataset text pasted for the currently-selected group.
  readonly datasetText = signal('');
  readonly datasetError = signal<string | null>(null);

  /** The resent call, fetched when "View the cycle" is pressed on a result, keyed by draft. */
  readonly journeys = signal<Readonly<Record<string, CallRecord | 'loading' | 'missing'>>>({});

  readonly drafts = this.service.drafts;
  readonly groups = this.service.groups;
  /** The list as it is drawn: every call, ticked or not, as a group or a loose call. */
  readonly listRuns = computed(() => this.service.listRuns(this.drafts()));
  /** Only the ticked ones - what a send would actually go out as. */
  readonly runs = this.service.runs;
  readonly included = computed(() => this.drafts().filter((d) => d.include));
  readonly editedCount = computed(() => this.drafts().filter(isEdited).length);
  /** Ticked calls not already in a group - what "Group ticked" and a group's "+" act on. */
  readonly groupableCount = computed(() => this.included().filter((d) => d.groupId === null).length);

  /** The 1-based position in the whole list, so a grouped row keeps a real number. */
  positionOf(draft: ResendDraft): number {
    return this.drafts().findIndex((d) => d.key === draft.key) + 1;
  }

  /** "3 sent", "1 failed", or "waiting" - a group's own tally, on its header. */
  runProgress(run: SendRun): string {
    const sent = run.drafts.filter((d) => this.resultOf(d)?.error === null).length;
    const failed = run.drafts.filter((d) => this.resultOf(d) && this.resultOf(d)!.error !== null).length;
    if (this.service.currentRun() === run) {
      const inFlight = run.drafts.filter((d) => !this.resultOf(d)).length;
      if (inFlight > 1) return `${sent + failed} done · ${inFlight} in flight`;
    }
    const parts = [`${sent} sent`];
    if (failed) parts.push(`${failed} failed`);
    if (!sent && !failed) parts.push('waiting');
    return parts.join(' · ');
  }

  modeHelp(mode: GroupMode): string {
    return mode === 'parallel'
      ? 'Parallel: every call in this group goes out at once. Use a delay to stagger them.'
      : 'Sequential: one at a time, in list order.';
  }

  // ---- what "Edit all at once" applies to ----

  readonly scopeGroupId = signal<string | null>(null);

  /** Every group with at least one ticked call, for the scope picker. */
  readonly groupChoices = computed(() =>
    Object.values(this.groups())
      .map((group) => ({ id: group.id, name: group.name, count: this.drafts().filter((d) => d.groupId === group.id && d.include).length }))
      .filter((choice) => choice.count > 0)
  );

  /**
   * The scope actually in force. A group can be dissolved under the scope - ungrouped, or pruned
   * away because a removal left it with one call - and a scope pointing at a group that no longer
   * exists would silently narrow every tool to nothing, so it falls back to all ticked calls.
   */
  readonly effectiveScopeId = computed(() => {
    const id = this.scopeGroupId();
    return id !== null && this.groups()[id] ? id : null;
  });

  readonly scopeValue = computed(() => this.effectiveScopeId() ?? 'all');

  /** The drafts the tools below touch - one source, so the counts cannot disagree with them. */
  readonly scopeDrafts = computed(() => {
    const id = this.effectiveScopeId();
    return id === null ? this.drafts() : this.drafts().filter((d) => d.groupId === id);
  });

  readonly scopeIncluded = computed(() => this.scopeDrafts().filter((d) => d.include));

  /** Any group set to parallel - which is what turns the delay into a stagger. */
  readonly hasParallel = computed(() => Object.values(this.groups()).some((g) => g.mode === 'parallel'));

  /**
   * "Sending 'Search' 2/5…" for one call in flight, "3 of 5 in flight" for a parallel group - a
   * single "2/5" would imply a queue that does not exist once calls overlap.
   */
  readonly runningLabel = computed(() => {
    const run = this.service.currentRun();
    if (!run) return 'Sending…';
    const name = run.group ? `"${run.group.name}"` : 'loose calls';
    const settled = run.drafts.filter((d) => this.resultOf(d)).length;
    if (run.group?.mode === 'parallel') return `Sending ${name}: ${settled}/${run.drafts.length} done`;
    return `Sending ${name} ${settled + 1}/${run.drafts.length}…`;
  });

  setScope(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.scopeGroupId.set(value === 'all' ? null : value);
  }

  readonly selected = computed(() => {
    const key = this.selectedKey();
    return this.drafts().find((d) => d.key === key) ?? this.drafts()[0] ?? null;
  });

  private readonly matcher = computed(() => buildMatcher(this.find(), { regex: this.regex(), matchCase: this.matchCase() }));
  readonly findError = computed(() => (this.find() ? matcherError(this.find(), { regex: this.regex(), matchCase: this.matchCase() }) : null));
  readonly matchCount = computed(() =>
    countMatches(this.scopeDrafts(), this.matcher(), { inUrl: this.inUrl(), inHeaders: this.inHeaders(), inBody: this.inBody() })
  );

  constructor() {
    // CDK evaluates enterPredicate during its document mousemove handler, before cdkDragMoved is
    // emitted. Capture the pointer first so the outer-list predicate never sees the previous move.
    const capturePointer = (event: MouseEvent | TouchEvent): void => {
      const point = 'touches' in event ? event.touches[0] ?? event.changedTouches[0] : event;
      if (point) this.dragPointer = { x: point.clientX, y: point.clientY };
    };
    document.addEventListener('mousemove', capturePointer, true);
    document.addEventListener('touchmove', capturePointer, { capture: true, passive: true });
    this.destroyRef.onDestroy(() => {
      document.removeEventListener('mousemove', capturePointer, true);
      document.removeEventListener('touchmove', capturePointer, true);
    });

    // Return from "Add calls from anywhere…" - the dialog stayed mounted, so react here.
    effect(() => {
      if (!this.picker.hasResult(PICK_REQUESTER)) return;
      untracked(() => {
        const result = this.picker.takeResult(PICK_REQUESTER);
        this.service.hidden.set(false);
        const picked = result?.picked ?? [];
        if (picked.length === 0) return;
        forkJoin(picked.map((p) => this.refDetail.hydrate(p.ref, p.call).pipe(map((call) => draftFrom(call, p.ref.cycleId)), catchError(() => of(null)))))
          .subscribe((drafts) => {
            const added = drafts.filter((d): d is ResendDraft => d !== null);
            this.service.append(added);
            this.notice.set(`${added.length} call${added.length === 1 ? '' : 's'} added${added.length < picked.length ? ` · ${picked.length - added.length} could not be loaded` : ''}.`);
          });
      });
    });
  }

  resultOf(draft: ResendDraft): DraftResult | null {
    return this.service.latestResult(draft.key);
  }

  /** Every attempt for a draft - a dataset gives one per row, a retry policy one per attempt. */
  resultsOf(draft: ResendDraft): readonly DraftResult[] {
    return this.service.resultsFor(draft.key);
  }

  /** "200 · 38 ms", "502 · failed", with a retry/row count folded in when there is more than one
   *  attempt - the list row's B2 result chip. */
  resultChip(draft: ResendDraft): string | null {
    const all = this.resultsOf(draft);
    if (all.length === 0) return null;
    const last = all[all.length - 1];
    const base = last.error === null ? `${last.status} · ${last.durationMs} ms` : `${last.status ?? 'failed'} · failed`;
    const rowCount = new Set(all.map((r) => r.row).filter((r) => r !== undefined)).size;
    const parts = [base];
    if (rowCount > 1) parts.push(`${rowCount} rows`);
    else if (all.length > 1) parts.push(`${all.length} attempts`);
    return parts.join(' · ');
  }

  isEdited = isEdited;
  describeEdits = describeEdits;

  select(draft: ResendDraft): void {
    this.selectedKey.set(draft.key);
    this.mode.set('call');
  }

  updateDraft(next: ResendDraft): void {
    this.service.drafts.update((all) => all.map((d) => (d.key === next.key ? next : d)));
  }

  updateAssertions(draft: ResendDraft, assertions: readonly Assertion[]): void {
    this.updateDraft({ ...draft, assertions });
  }

  toggleInclude(draft: ResendDraft, event: Event): void {
    event.stopPropagation();
    this.updateDraft({ ...draft, include: (event.target as HTMLInputElement).checked });
  }

  /**
   * A call's own arrows, which swap it with its neighbour. A grouped call swaps with the next
   * member of its own group; a loose one swaps with the neighbouring run - which may be a whole
   * group, and then the two blocks change places.
   */
  moveBy(draft: ResendDraft, delta: number, event: Event): void {
    event.stopPropagation();
    if (this.service.running()) return;
    if (draft.groupId) {
      const members = draftsInGroup(this.drafts(), draft.groupId);
      const from = members.findIndex((d) => d.key === draft.key);
      const to = runAtOffset(from, delta, members.length);
      if (to === null) return;
      this.applyGroups(swapMembers(this.drafts(), draft.groupId, from, to));
      return;
    }
    const runs = this.listRuns();
    const from = runs.findIndex((run) => run.drafts.some((d) => d.key === draft.key));
    const to = runAtOffset(from, delta, runs.length);
    if (from < 0 || to === null) return;
    this.service.drafts.set(swapRuns(this.drafts(), from, to));
  }

  moveRunBy(index: number, delta: number, event: Event): void {
    event.stopPropagation();
    if (this.service.running()) return;
    const to = runAtOffset(index, delta, this.listRuns().length);
    if (to === null) return;
    this.service.drafts.set(swapRuns(this.drafts(), index, to));
  }

  /**
   * A drop on the OUTER list: the runs, so a group moves as one block and a loose call moves alone.
   * Reordering here is a SWAP between the two runs - the dragged one and the one it was let go over
   * change places and nothing in between shifts. A call dragged OUT of a group leaves instead, and
   * lands just before the run it was dropped on.
   */
  dropOuter(event: CdkDragDrop<SendRun[]>): void {
    if (this.service.running()) return;
    const payload = event.item.data as DragPayload | undefined;
    if (!payload) return;
    if (payload.kind === 'call' && this.dropGroupedCallIntoHitGroup(event.dropPoint, payload.draft)) return;

    // A grouped call is never an outer-list item. CDK can report the outer list as both previous
    // and current container for nested drags, so group membership determines whether this is an
    // extraction; container equality alone is not enough.
    if (payload.kind === 'call' && payload.draft.groupId !== null) {
      this.applyGroups(extractToRun(this.drafts(), payload.draft, this.runIndexAtDrop(event.dropPoint, event.currentIndex)));
      this.notice.set('Moved out of the group.');
      return;
    }

    if (event.previousContainer === event.container) {
      this.service.drafts.set(swapRuns(this.drafts(), event.previousIndex, event.currentIndex));
      return;
    }
    if (payload.kind !== 'call') return;
    this.applyGroups(extractToRun(this.drafts(), payload.draft, this.runIndexAtDrop(event.dropPoint, event.currentIndex)));
    this.notice.set('Moved out of the group.');
  }

  /**
   * A nested CDK list can occasionally report the containing outer list for a drop over a member.
   * The pointer's actual drop target is authoritative: keep the call in the group it landed in,
   * even if CDK's container bookkeeping says it left.
   */
  private dropGroupedCallIntoHitGroup(point: { x: number; y: number } | undefined, draft: ResendDraft): boolean {
    if (draft.groupId === null) return false;
    const target = this.elementAtDrop(point);
    const groupId = target?.closest('.br-group-list')?.closest<HTMLElement>('[data-group-id]')?.dataset['groupId'];
    if (!groupId) return false;

    const members = draftsInGroup(this.drafts(), groupId);
    const row = target?.closest<HTMLElement>('.br-row');
    const position = row ? Number(row.querySelector('.br-index')?.textContent?.trim()) - 1 : -1;
    const targetKey = position >= 0 ? this.drafts()[position]?.key : undefined;
    const targetIndex = members.findIndex((member) => member.key === targetKey);
    const sourceIndex = draftsInGroup(this.drafts(), draft.groupId).findIndex((member) => member.key === draft.key);
    const insertionIndex = targetIndex >= 0 ? targetIndex : members.length;

    if (groupId === draft.groupId) {
      if (targetIndex >= 0 && sourceIndex >= 0) {
        this.service.drafts.set(swapMembers(this.drafts(), groupId, sourceIndex, targetIndex));
      }
    } else {
      this.applyGroups(addMemberAt(this.drafts(), groupId, draft, insertionIndex));
      this.selectGroup(groupId);
    }
    return true;
  }

  private runIndexAtDrop(point: { x: number; y: number } | undefined, fallbackIndex: number): number {
    if (!point) return Math.min(fallbackIndex, this.listRuns().length);
    const target = this.elementAtDrop(point);
    const row = target?.closest<HTMLElement>('.br-row');
    if (row) {
      const position = Number(row.querySelector('.br-index')?.textContent?.trim()) - 1;
      const key = this.drafts()[position]?.key;
      const index = this.listRuns().findIndex((run) => run.drafts.some((draft) => draft.key === key));
      if (index >= 0) return index;
    }
    const group = target?.closest<HTMLElement>('[data-group-id]');
    if (group?.dataset['groupId']) {
      const index = this.listRuns().findIndex((run) => run.group?.id === group.dataset['groupId']);
      if (index >= 0) return index;
    }
    return Math.min(fallbackIndex, this.listRuns().length);
  }

  private elementAtDrop(point: { x: number; y: number } | undefined): Element | null {
    return point ? document.elementFromPoint(point.x - window.scrollX, point.y - window.scrollY) : null;
  }

  private memberIndexAtDrop(target: Element | null, groupId: string, fallbackIndex = 0): number {
    const row = target?.closest<HTMLElement>('.br-row');
    const position = row ? Number(row.querySelector('.br-index')?.textContent?.trim()) - 1 : -1;
    const key = position >= 0 ? this.drafts()[position]?.key : undefined;
    const index = draftsInGroup(this.drafts(), groupId).findIndex((draft) => draft.key === key);
    return index >= 0 ? index : Math.min(fallbackIndex, draftsInGroup(this.drafts(), groupId).length);
  }

  /**
   * A drop inside a GROUP's own list: its members. Two members change places; a loose call
   * arriving from the outer list joins the group at that position. A whole group dragged in here
   * is ignored - merging two groups is not a thing, and guessing would be worse than doing nothing.
   */
  dropInside(event: CdkDragDrop<readonly ResendDraft[]>, groupId: string): void {
    if (this.service.running()) return;
    const payload = event.item.data as DragPayload | undefined;
    if (!payload || payload.kind !== 'call') return;
    const target = this.elementAtDrop(event.dropPoint);
    const actualGroupId = target?.closest('.br-group-list')?.closest<HTMLElement>('[data-group-id]')?.dataset['groupId'] ?? null;

    if (payload.draft.groupId !== null && event.dropPoint && actualGroupId === null) {
      this.applyGroups(extractToRun(this.drafts(), payload.draft, this.runIndexAtDrop(event.dropPoint, event.currentIndex)));
      this.notice.set('Moved out of the group.');
      return;
    }

    const destinationGroupId = actualGroupId ?? groupId;
    if (destinationGroupId !== groupId) {
      this.applyGroups(addMemberAt(this.drafts(), destinationGroupId, payload.draft, this.memberIndexAtDrop(target, destinationGroupId, event.currentIndex)));
      this.selectGroup(destinationGroupId);
      return;
    }

    if (event.previousContainer === event.container && payload.draft.groupId === groupId) {
      this.applyGroups(swapMembers(this.drafts(), groupId, event.previousIndex, event.currentIndex));
      return;
    }
    this.applyGroups(addMemberAt(this.drafts(), groupId, payload.draft, this.memberIndexAtDrop(target, groupId, event.currentIndex)));
    const name = this.groups()[groupId]?.name;
    if (name) {
      this.selectGroup(groupId);
      this.notice.set(`Added to ${name}.`);
    }
  }

  /**
   * CDK picks the first connected drop list under the pointer. Since the outer list contains every
   * group list, it otherwise wins over the group's own list. Remember the pointer from CDK's move
   * event so the outer enter predicate can yield while the pointer is over any group member.
   */
  private dragPointer: { x: number; y: number } | null = null;

  readonly canEnterOuter = (drag: CdkDrag<DragPayload>): boolean => {
    const payload = drag.data;
    if (payload?.kind !== 'call' || payload.draft.groupId === null || !this.dragPointer) return true;
    const element = document.elementFromPoint(this.dragPointer.x, this.dragPointer.y);
    return !element?.closest('.br-group-list');
  };

  /** The outer drop list's DOM id, referenced by every group's list so a member can be dragged out. */
  readonly outerListId = OUTER_LIST;

  groupListId(groupId: string): string {
    return `br-group-${groupId}`;
  }

  /** The outer list accepts a drop from every group's list - that is how a member gets out. */
  groupListIds(): string[] {
    return Object.keys(this.groups()).map((id: string) => this.groupListId(id));
  }

  groupListConnections(groupId: string): string[] {
    return [this.outerListId, ...Object.keys(this.groups())
      .filter((id) => id !== groupId)
      .map((id) => this.groupListId(id))];
  }

  // ---- groups ----

  /** Every ticked call not already in a group becomes one new group, named and left to rename. */
  groupIncluded(): void {
    const members = this.included().filter((d) => d.groupId === null);
    if (members.length < 2) {
      this.notice.set(
        members.length === 1 ? 'Tick at least one more loose call to make a group.' : 'Tick the calls to group first.'
      );
      return;
    }
    const id = newGroupId();
    const groups = this.service.groups();
    this.applyGroups(groupDrafts(this.drafts(), members, id), {
      ...groups,
      [id]: { id, name: nextGroupName(groups), mode: 'sequential' },
    });
    this.selectGroup(id);
    this.scopeGroupId.set(id);
    this.notice.set(`${members.length} calls grouped. Drag the group to move them all.`);
  }

  /** A group's "+": every ticked loose call joins it, landing at the end of its run. */
  addIncludedTo(groupId: string, event: Event): void {
    event.stopPropagation();
    const members = this.included().filter((d) => d.groupId === null);
    if (members.length === 0) {
      this.notice.set('Tick the loose calls to add first.');
      return;
    }
    this.applyGroups(addToGroup(this.drafts(), groupId, members));
    this.notice.set(`${members.length} call${members.length === 1 ? '' : 's'} added to the group.`);
  }

  ungroupFrom(groupId: string, event: Event): void {
    event.stopPropagation();
    this.applyGroups(ungroup(this.drafts(), groupId));
    if (this.service.activeGroupId() === groupId) this.service.activeGroupId.set(null);
    if (this.scopeGroupId() === groupId) this.scopeGroupId.set(null);
  }

  renameGroup(groupId: string, event: Event): void {
    const name = (event.target as HTMLInputElement).value.trim() || 'Group';
    this.service.groups.update((all) => ({ ...all, [groupId]: { ...all[groupId], name } }));
  }

  /** Enter in the name field commits it, rather than needing a click elsewhere first. */
  commitName(event: Event): void {
    (event.target as HTMLInputElement).blur();
  }

  setGroupMode(groupId: string, event: Event): void {
    const mode = (event.target as HTMLSelectElement).value as GroupMode;
    this.service.groups.update((all) => ({ ...all, [groupId]: { ...all[groupId], mode } }));
  }

  selectGroup(groupId: string): void {
    this.service.activeGroupId.set(groupId);
  }

  /**
   * Every structural change goes through here, so a group that loses a call (added to another
   * group, ungrouped, or removed from the resend) is dissolved rather than left holding one.
   */
  private applyGroups(drafts: ResendDraft[], groups = this.service.groups()): void {
    const pruned = pruneGroups(drafts, groups);
    this.service.drafts.set(pruned.drafts);
    this.service.groups.set(pruned.groups);
    // A group can be dissolved here as well as by Ungroup, so the scope cannot be left pointing
    // at one that is gone (effectiveScopeId also refuses, but the picker should not offer it).
    if (this.scopeGroupId() !== null && !pruned.groups[this.scopeGroupId()!]) this.scopeGroupId.set(null);
    if (this.service.activeGroupId() !== null && !pruned.groups[this.service.activeGroupId()!]) {
      this.service.activeGroupId.set(null);
    }
  }

  remove(draft: ResendDraft, event: Event): void {
    event.stopPropagation();
    this.applyGroups(this.drafts().filter((d) => d.key !== draft.key));
  }

  reset(draft: ResendDraft): void {
    this.updateDraft(resetDraft(draft));
  }

  // ---- edit all at once ----

  /**
   * Applies a tool to the current SCOPE, not the whole list: the helpers map over every draft
   * handed to them, so the scope is applied by narrowing what is passed in and merging the
   * untouched rows back - which is what keeps a grouped call's neighbours out of it.
   */
  private applyScoped(change: (drafts: readonly ResendDraft[]) => readonly ResendDraft[], message: (count: number) => string): void {
    const scope = this.scopeDrafts();
    const changed = change(scope);
    const byKey = new Map(changed.map((d) => [d.key, d]));
    this.service.drafts.set(this.drafts().map((d) => byKey.get(d.key) ?? d));
    this.notice.set(message(scope.filter((d) => d.include).length));
  }

  setHeader(): void {
    const name = this.headerName().trim();
    if (!name) return;
    this.applyScoped(
      (drafts) => setHeaderOnAll(drafts, name, this.headerValue()),
      (count) => `${name} set on ${count} call${count === 1 ? '' : 's'}.`
    );
  }

  removeHeader(): void {
    const name = this.headerName().trim();
    if (!name) return;
    this.applyScoped(
      (drafts) => removeHeaderFromAll(drafts, name),
      (count) => `${name} removed from ${count} call${count === 1 ? '' : 's'}.`
    );
  }

  replaceAll(): void {
    const count = this.matchCount();
    if (!count) return;
    this.applyScoped(
      // Plain mode means plain on both sides: a "$1" typed as the replacement is text, not a group.
      (drafts) =>
        findReplaceAll(drafts, this.matcher(), this.regex() ? this.replace() : literalReplacement(this.replace()), {
          inUrl: this.inUrl(),
          inHeaders: this.inHeaders(),
          inBody: this.inBody(),
        }),
      (n) => `${count} match${count === 1 ? '' : 'es'} replaced in ${n} call${n === 1 ? '' : 's'}.`
    );
  }

  applyMethodAndHost(): void {
    const parts: string[] = [];
    if (this.method().trim()) parts.push(`method ${this.method().trim().toUpperCase()}`);
    if (this.host().trim()) parts.push(`host ${this.host().trim()}`);
    if (parts.length === 0) return;
    // setHostOnAll reports how many inbound calls it had to leave alone; that count belongs to the
    // message, so it is captured out of the helper rather than recomputed.
    let skipped = 0;
    this.applyScoped((drafts) => {
      let out = this.method().trim() ? setMethodOnAll(drafts, this.method()) : drafts;
      if (this.host().trim()) {
        const result = setHostOnAll(out, this.host());
        out = result.drafts;
        skipped = result.skipped;
      }
      return out;
    }, (count) => {
      const host = this.host().trim();
      const detail = host && skipped ? ` (${skipped} inbound left alone)` : '';
      return `Set ${parts.join(' and ')}${detail} on ${count} call${count === 1 ? '' : 's'}.`;
    });
  }

  setSessionOnAll(event: Event): void {
    const on = (event.target as HTMLInputElement).checked;
    this.applyScoped(
      (drafts) => setCurrentSessionOnAll(drafts, on),
      (count) => (on ? `Current session on for ${count} call${count === 1 ? '' : 's'}.` : 'Current session off.')
    );
  }

  text(signalSetter: (value: string) => void, event: Event): void {
    signalSetter((event.target as HTMLInputElement).value);
  }

  checked(signalSetter: (value: boolean) => void, event: Event): void {
    signalSetter((event.target as HTMLInputElement).checked);
  }

  onDelay(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.delayMs.set(Number.isFinite(value) ? Math.min(Math.max(0, Math.round(value)), 60_000) : 0);
  }

  // ---- C1: chaining ("Pass on") ----

  /** What the selected call passes on to later drafts - the "Pass on" editor's own list. */
  extractRulesOf(draft: ResendDraft): readonly ExtractRule[] {
    return draft.extract ?? [];
  }

  addExtractRule(draft: ResendDraft): void {
    const as = this.extractAs().trim();
    const path = this.extractPath().trim();
    if (!as || !path) return;
    const rule: ExtractRule = {
      from: this.extractFrom(),
      path,
      as,
      missing: this.extractMissing(),
      ...(this.extractMissing() === 'FALLBACK' ? { fallback: this.extractFallback() } : {}),
    };
    this.updateDraft({ ...draft, extract: [...this.extractRulesOf(draft), rule] });
    this.extractPath.set('');
    this.extractAs.set('');
    this.extractFallback.set('');
  }

  removeExtractRule(draft: ResendDraft, index: number): void {
    this.updateDraft({ ...draft, extract: this.extractRulesOf(draft).filter((_, i) => i !== index) });
  }

  /** Chip text for a list row: what it passes on (`this.token`) and what it uses from earlier
   *  calls (any `{{this.x}}` its own method/url/headers/body references). */
  passesOnChip(draft: ResendDraft): string | null {
    const names = this.extractRulesOf(draft).map((r) => r.as);
    return names.length ? `passes on ${names.map((n) => `this.${n}`).join(', ')}` : null;
  }

  usesChip(draft: ResendDraft): string | null {
    const text = [draft.method, draft.url, draft.body, ...draft.headers.map((h) => h.value)].join(' ');
    const names = new Set<string>();
    for (const m of text.matchAll(/\{\{this\.([A-Za-z0-9_.-]+)\}\}/g)) names.add(m[1]);
    for (const m of text.matchAll(/\{\{\$base64:this\.([A-Za-z0-9_.-]+)\}\}/g)) names.add(m[1]);
    return names.size ? `uses ${[...names].map((n) => `this.${n}`).join(', ')}` : null;
  }

  // ---- D3: retry, parallel cap, datasets ----

  applyRetry(): void {
    const attempts = Math.min(Math.max(0, Math.round(Number(this.retryAttempts()) || 0)), 5);
    const on: RetryPolicy['on'] = [...(this.retryOn5xx() ? (['5XX'] as const) : []), ...(this.retryOnNetwork() ? (['NETWORK'] as const) : [])];
    this.service.retry.set(attempts === 0 || on.length === 0 ? null : { attempts, backoffMs: Math.max(0, Math.round(this.retryBackoffMs()) || 0), on });
  }

  clearRetry(): void {
    this.retryAttempts.set(0);
    this.service.retry.set(null);
  }

  applyMaxParallel(): void {
    const raw = this.maxParallelInput().trim();
    if (!raw) {
      this.service.maxParallel.set(null);
      return;
    }
    const n = Math.round(Number(raw));
    this.service.maxParallel.set(Number.isFinite(n) && n > 0 ? n : null);
  }

  datasetOf(groupId: string): Dataset | null {
    return this.service.datasets()[groupId] ?? null;
  }

  /** First 3 rows of the active group's dataset, for the preview under the paste box. */
  datasetPreview(groupId: string): readonly Record<string, string>[] {
    return this.datasetOf(groupId)?.rows.slice(0, 3) ?? [];
  }

  applyDataset(groupId: string, groupName: string, onRowFailure: 'SKIP' | 'STOP'): void {
    const parsed = parseDatasetText(this.datasetText());
    if (parsed.error) {
      this.datasetError.set(parsed.error);
      return;
    }
    this.datasetError.set(null);
    if (parsed.rows.length === 0) {
      this.service.datasets.update(({ [groupId]: _removed, ...rest }) => rest);
      return;
    }
    this.service.datasets.update((all) => ({ ...all, [groupId]: { name: groupName, rows: parsed.rows, onRowFailure } }));
  }

  clearDataset(groupId: string): void {
    this.datasetText.set('');
    this.datasetError.set(null);
    this.service.datasets.update(({ [groupId]: _removed, ...rest }) => rest);
  }

  setDatasetRowFailure(groupId: string, event: Event): void {
    const value = (event.target as HTMLSelectElement).value as 'SKIP' | 'STOP';
    const current = this.datasetOf(groupId);
    if (!current) return;
    this.service.datasets.update((all) => ({ ...all, [groupId]: { ...current, onRowFailure: value } }));
  }

  // ---- B4: a stable, unique tail for a long URL ----

  /** The end of the path, with a leading ellipsis when it was truncated - the full URL stays in
   *  the title tooltip. Grows the tail (or falls back to the full path) until it no longer matches
   *  another visible row's tail, so two different calls never render identically. */
  urlTail(draft: ResendDraft): string {
    const others = this.listRuns()
      .flatMap((run) => run.drafts)
      .filter((d) => d.key !== draft.key)
      .map((d) => d.url);
    return uniqueTail(draft.url, others);
  }

  // ---- B2: progress ----

  /** ok/failed/in-flight/waiting segment widths (percent) for the sticky footer's progress bar. */
  progressSegments(): { ok: number; failed: number; inFlight: number; waiting: number } {
    const total = this.service.total() || 1;
    const results = Object.values(this.service.results()).flat();
    const ok = results.filter((r) => r.error === null).length;
    const failed = results.filter((r) => r.error !== null).length;
    const inFlight = this.service.inFlight();
    const waiting = Math.max(0, total - ok - failed - inFlight);
    const pct = (n: number) => (100 * n) / total;
    return { ok: pct(ok), failed: pct(failed), inFlight: pct(inFlight), waiting: pct(waiting) };
  }

  liveCallsHref(): string {
    return '/';
  }

  // ---- send / pick / close ----

  send(): void {
    this.notice.set(null);
    this.journeys.set({});
    this.service.send({ stopOnFailure: this.stopOnFailure(), delayMs: this.delayMs() });
  }

  addFromAnywhere(): void {
    this.picker.start({
      requester: PICK_REQUESTER,
      title: 'Calls to add to the resend',
      mode: 'multi',
      returnUrl: this.router.url,
      returnLabel: 'the resend editor',
      refuse: this.drafts().map((d) => ({ ref: d.ref, reason: 'Already in this resend' })),
    });
    this.service.hidden.set(true);
  }

  close(): void {
    this.service.close();
  }

  /** Loads the resent call and shows its whole cycle (the Resent panel) under the result. */
  viewCycle(draft: ResendDraft): void {
    const result = this.resultOf(draft);
    if (!result?.newCallId) return;
    if (this.journeys()[draft.key]) {
      const { [draft.key]: _closed, ...rest } = this.journeys();
      this.journeys.set(rest);
      return;
    }
    const id = result.newCallId;
    const source = draft.ref.source;
    this.journeys.update((all) => ({ ...all, [draft.key]: 'loading' }));
    this.callsApi
      .getCalls({ search: '', supplier: '', sort: 'newest', offset: 0, limit: 5, sessionId: '', operationId: '', requestId: id }, source)
      .pipe(
        map((page) => page.calls.find((c) => c.id === id) ?? null),
        catchError(() => of(null))
      )
      .subscribe((call) => this.journeys.update((all) => ({ ...all, [draft.key]: call ?? 'missing' })));
  }

  journeyOf(draft: ResendDraft): CallRecord | 'loading' | 'missing' | null {
    return this.journeys()[draft.key] ?? null;
  }

  asCall(value: CallRecord | 'loading' | 'missing' | null): CallRecord | null {
    return value && typeof value === 'object' ? value : null;
  }

  hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  pathOf(url: string): string {
    try {
      const u = new URL(url);
      return u.pathname + u.search;
    } catch {
      return url;
    }
  }

  originOf(draft: ResendDraft): string {
    const where = draft.ref.cycleId ? 'cycle' : 'live';
    return `${directionOf(draft.ref)} · ${where}`;
  }

  newCallHref(result: DraftResult): string {
    return `/?requestId=${encodeURIComponent(result.newCallId ?? '')}`;
  }
}

/**
 * B4: the last `segments` path segments of `url`, ellipsised, growing by one segment (then falling
 * back to the full URL) until it stops matching any of `others` - so two different calls never
 * render the same tail even when they share a long common path.
 */
function uniqueTail(url: string, others: readonly string[], segments = 2): string {
  const parts = pathSegmentsOf(url);
  if (parts.length === 0) return url;
  const tailAt = (path: string, n: number): string => {
    const p = pathSegmentsOf(path);
    if (p.length === 0) return path;
    const take = Math.min(n, p.length);
    const tail = p.slice(-take).join('/');
    return take < p.length ? `…/${tail}` : `/${tail}`;
  };
  for (let n = Math.min(segments, parts.length); n <= parts.length; n++) {
    const text = tailAt(url, n);
    if (!others.some((other) => tailAt(other, n) === text)) return text;
  }
  return url;
}

function pathSegmentsOf(url: string): string[] {
  try {
    return new URL(url).pathname.split('/').filter(Boolean);
  } catch {
    return url.split('/').filter(Boolean);
  }
}
