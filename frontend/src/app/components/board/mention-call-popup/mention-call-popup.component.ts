import { Component, HostListener, Injectable, computed, effect, forwardRef, inject, signal, untracked } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';
import { CallBadge, STATUS_LABELS } from '../../../core/models/board.models';
import { CallDetail, CallDetailPart, CallEndpointSource, CallRecord } from '../../../core/models/call.model';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardMentionsService, MentionCallTarget } from '../../../core/services/board-mentions.service';
import { CallsApiService } from '../../../core/services/calls-api.service';
import { SessionCyclesApiService } from '../../../core/services/session-cycles-api.service';
import { CALL_ORIGIN, CallOrigin, LIVE_ORIGIN_LABEL } from '../../../core/state/call-origin.token';
import { CALL_LIST_CONTROLS_STATE, CALL_SELECTION_STATE, CallListControlsState, CallSelectionState } from '../../../core/state/call-selection.tokens';
import { CallWaterfallComponent } from '../../call-waterfall/call-waterfall.component';
import { CallFamily, CallFamilyService, familySize } from '../../../core/services/call-family.service';
import { CallTreeNode, indexCallTree, indexDescendants } from '../../../shared/utils/call-tree';
import { SortMode } from '../../../core/models/call.model';
import { DbWindowService } from '../../db-capture/db-window.service';

/** Every block of the call open at once: the popup is there to show the whole call. */
export const POPUP_OPEN_PARTS: readonly CallDetailPart[] = ['request-headers', 'request-body', 'response-headers', 'response-body'];

const NO_SELECTION: CallSelectionState = {
  isSelected: () => false,
  toggleSelected: () => undefined,
  startDragSelect: () => undefined,
  dragSelectOver: () => undefined,
  endDragSelect: () => undefined,
  subtreeSelection: () => 'none',
  setSubtreeSelected: () => undefined,
};

/**
 * What the waterfall and its cards ask the list they sit in: here, each call's detail from Live Calls or from its cycle,
 * the family's descendants, and which lines are folded (this popup's own).
 */
@Injectable()
class PopupCallControls {
  host?: MentionCallPopupComponent;
  readonly expanded = computed(() => false);
  readonly collapseAllVersion = computed(() => 0);
  readonly sortMode = signal<SortMode>('oldest-call');
  readonly foldedIds = signal<ReadonlySet<string>>(new Set());
  readonly descendants = computed(() => {
    const root = this.host?.tree();
    return root ? indexDescendants([root]) : new Map();
  });

  setFolded(ids: readonly string[], folded: boolean): void {
    const next = new Set(this.foldedIds());
    ids.forEach((id) => (folded ? next.add(id) : next.delete(id)));
    this.foldedIds.set(next);
  }

  getCallDetail(callId: string, source?: CallEndpointSource, part?: CallDetailPart): Observable<CallDetail> {
    return this.host?.detail(callId, source, part) ?? of({});
  }
}

/** Where the card's call comes from, for anything that must name it precisely (a pick, a resend). */
@Injectable()
class PopupCallOrigin implements CallOrigin {
  host?: MentionCallPopupComponent;
  readonly cycleId = computed(() => this.host?.target()?.cycleId ?? null);
  readonly label = computed(() => (this.host?.target()?.cycleId ? 'Cycle' : LIVE_ORIGIN_LABEL));
}

/**
 * A call mention opened in place (board chips): the Live Calls call card itself - same component, same blocks, same
 * actions - with every block open, the cards that mention the call, and a way to go to it in Live Calls or its cycle.
 * Shown for whichever call BoardMentionsService.callToShow names.
 */
@Component({
  selector: 'app-mention-call-popup',
  standalone: true,
  imports: [CallWaterfallComponent],
  providers: [
    PopupCallControls,
    PopupCallOrigin,
    { provide: CALL_SELECTION_STATE, useValue: NO_SELECTION },
    {
      provide: CALL_LIST_CONTROLS_STATE,
      useFactory: (controls: PopupCallControls): CallListControlsState => controls as unknown as CallListControlsState,
      deps: [forwardRef(() => PopupCallControls)],
    },
    { provide: CALL_ORIGIN, useExisting: forwardRef(() => PopupCallOrigin) },
  ],
  template: `
    @if (target(); as t) {
      <div class="dialog-backdrop" (click)="close()">
        <div class="dialog-card board-call-pop" role="dialog" aria-label="Call" (click)="$event.stopPropagation()">
          <div class="board-call-pop-head">
            <div class="board-call-pop-title">
              <span class="board-mention board-mention-call"><span class="board-mention-icon">⇄</span>{{ t.label }}</span>
              <span class="board-call-pop-badge">{{ t.direction === 'out' ? 'outbound' : 'inbound' }}</span>
              <span class="board-call-pop-badge">{{ t.cycleId ? 'in a cycle' : 'live' }}</span>
            </div>
            @if (call()) {
              <button type="button" class="action-btn primary" (click)="goTo()">{{ t.cycleId ? 'Open in its cycle ↗' : 'Open in Live Calls ↗' }}</button>
            }
            <button type="button" class="board-drawer-x" title="Close (Esc)" (click)="close()">✕</button>
          </div>
          <div class="board-call-pop-body">
            @if (call(); as c) {
              <div class="board-call-pop-sum">
                <span [class.board-dim]="familyLoading()">{{ summary() }}</span>
                @if (truncated()) { <span class="board-dim">· the first {{ maxCalls }} shown - open it in Live Calls for all</span> }
              </div>
              @if (tree(); as root) {
                <!-- Live Calls' waterfall in its own chunk: the popup lives in the first bundle, the waterfall need not -->
                @defer (on immediate) {
                  <app-call-waterfall [nodes]="[root]" [depths]="depths()" [targetCallId]="c.id" [targetOpenParts]="targetParts()" />
                } @placeholder { <div class="board-dim">Loading the call…</div> }
              }
            } @else if (gone()) {
              <div class="board-call-pop-gone">Removed - this is the label it was saved with: <b>{{ t.label }}</b></div>
            } @else {
              <div class="board-dim">Loading the call…</div>
            }
          </div>
          @if (cards().length) {
            <div class="board-call-pop-foot">On cards:
              @for (b of cards(); track b.project + '#' + b.number) {
                <button type="button" class="board-link" (click)="openCard(b)">#{{ b.number }} {{ b.title ?? '' }}</button>
                <span class="board-dim">({{ statusLabels[b.status] }})</span>
              }
            </div>
          }
        </div>
      </div>
    }`,
})
export class MentionCallPopupComponent {
  private readonly mentions = inject(BoardMentionsService);
  private readonly calls = inject(CallsApiService);
  private readonly cycles = inject(SessionCyclesApiService);
  private readonly board = inject(BoardApiService);
  private readonly dbWindow = inject(DbWindowService);
  private readonly families = inject(CallFamilyService);

  readonly target = this.mentions.callToShow;
  readonly call = signal<CallRecord | null>(null);
  readonly gone = signal(false);
  readonly cards = signal<readonly CallBadge[]>([]);
  readonly openParts = POPUP_OPEN_PARTS;
  readonly statusLabels = STATUS_LABELS;
  readonly maxCalls = 200;
  /** The call's family as Live Calls nests it (specs/025): from its top call down, every level - the call alone until it loads. */
  readonly family = signal<CallFamily | null>(null);
  readonly familyLoading = signal(false);
  readonly tree = computed<CallTreeNode | null>(() => this.family()?.root ?? (this.call() ? { call: this.call()!, children: [], depth: 0 } : null));
  readonly depths = computed(() => indexCallTree(this.family()?.calls ?? (this.call() ? [this.call()!] : [])));
  readonly size = computed(() => (this.tree() ? familySize(this.tree()!) : null));
  readonly truncated = computed(() => this.family()?.truncated ?? false);
  /** Every block open for a call alone; folded when calls sit under it, so its card does not push them out of sight. */
  readonly targetParts = computed(() => (this.size()?.calls ? [] : this.openParts));
  /** "3 calls under it · 2 levels", "… under its top call" for a call deep in a tree, or that it called nothing. */
  readonly summary = computed(() => {
    if (this.familyLoading()) return 'Looking for the calls above and under it…';
    const s = this.size();
    if (!s) return '';
    if (!s.calls) return 'no outbound calls - all its time was its own work';
    const where = this.tree()?.call.id === this.call()?.id ? 'it' : 'its top call';
    return `${s.calls} call${s.calls === 1 ? '' : 's'} under ${where} · ${s.levels} level${s.levels === 1 ? '' : 's'}`;
  });

  constructor() {
    inject(PopupCallControls).host = this;
    inject(PopupCallOrigin).host = this;
    effect((onCleanup) => {
      const t = this.target();
      untracked(() => {
        this.call.set(null);
        this.gone.set(false);
        this.cards.set([]);
        this.family.set(null);
        this.familyLoading.set(false);
      });
      if (!t) return;
      const source: CallEndpointSource = t.direction === 'out' ? 'external' : 'internal';
      const call$: Observable<CallRecord | null> = t.cycleId
        ? this.cycles.listCalls(t.cycleId, { search: '', supplier: '', sort: 'newest', offset: 0, limit: 1, sessionId: '', operationId: '',
            requestId: t.callId }, source).pipe(map((page) => page.calls.map((c) => c.call).find((c) => c.id === t.callId) ?? null))
        : this.calls.getSummary(t.callId, source);
      let family: { unsubscribe(): void } | null = null;
      const sub = call$.pipe(catchError(() => of(null))).subscribe((c) => {
        this.call.set(c);
        this.gone.set(!c);
        // specs/021: a statement, log line or Redis chip - its call here, and the database window at that part
        if (c && t.part) this.dbWindow.openCall(c, t.part, t.cycleId, t.seq ?? null);
        if (c) {
          this.familyLoading.set(true);
          family = this.families.load(c, t.cycleId).subscribe((f) => {
            this.family.set(f);
            this.familyLoading.set(false);
          });
        }
      });
      const badges = this.board.callBadges([t.callId]).pipe(catchError(() => of({} as Record<string, CallBadge[]>)))
        .subscribe((b) => this.cards.set(b[t.callId] ?? []));
      onCleanup(() => {
        family?.unsubscribe();
        sub.unsubscribe();
        badges.unsubscribe();
      });
    }, { allowSignalWrites: true });
  }

  detail(callId: string, source?: CallEndpointSource, part?: CallDetailPart): Observable<CallDetail> {
    const t = this.target();
    const from = source ?? (t?.direction === 'out' ? 'external' : 'internal');
    return t?.cycleId ? this.cycles.getDetail(t.cycleId, callId, from, part) : this.calls.getDetail(callId, from, part);
  }

  goTo(): void {
    const t = this.target();
    if (!t) return;
    this.mentions.goToCall(t, this.call()?.service_name ?? null);
  }

  openCard(b: CallBadge): void {
    this.close();
    this.mentions.cardToOpen.set({ project: b.project, number: b.number });
  }

  /** Esc closes the popup only - not the card drawer under it (listening on the same document, registered later). */
  @HostListener('document:keydown.escape', ['$event'])
  onEscape(event: Event): void {
    if (!this.target()) return;
    event.stopImmediatePropagation();
    this.close();
  }

  close(): void {
    this.mentions.callToShow.set(null);
  }
}

