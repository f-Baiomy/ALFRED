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
import { CallCardComponent } from '../../call-card/call-card.component';

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

/** What the card asks the list it sits in: here, the one call's detail from Live Calls or from its cycle. */
@Injectable()
class PopupCallControls {
  host?: MentionCallPopupComponent;
  readonly expanded = computed(() => false);
  readonly collapseAllVersion = computed(() => 0);

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
  imports: [CallCardComponent],
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
              <app-call-card [call]="c" [openAtStart]="openParts" />
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

  readonly target = this.mentions.callToShow;
  readonly call = signal<CallRecord | null>(null);
  readonly gone = signal(false);
  readonly cards = signal<readonly CallBadge[]>([]);
  readonly openParts = POPUP_OPEN_PARTS;
  readonly statusLabels = STATUS_LABELS;

  constructor() {
    inject(PopupCallControls).host = this;
    inject(PopupCallOrigin).host = this;
    effect((onCleanup) => {
      const t = this.target();
      untracked(() => {
        this.call.set(null);
        this.gone.set(false);
        this.cards.set([]);
      });
      if (!t) return;
      const source: CallEndpointSource = t.direction === 'out' ? 'external' : 'internal';
      const call$: Observable<CallRecord | null> = t.cycleId
        ? this.cycles.listCalls(t.cycleId, { search: '', supplier: '', sort: 'newest', offset: 0, limit: 1, sessionId: '', operationId: '',
            requestId: t.callId }, source).pipe(map((page) => page.calls.map((c) => c.call).find((c) => c.id === t.callId) ?? null))
        : this.calls.getSummary(t.callId, source);
      const sub = call$.pipe(catchError(() => of(null))).subscribe((c) => {
        this.call.set(c);
        this.gone.set(!c);
      });
      const badges = this.board.callBadges([t.callId]).pipe(catchError(() => of({} as Record<string, CallBadge[]>)))
        .subscribe((b) => this.cards.set(b[t.callId] ?? []));
      onCleanup(() => {
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

