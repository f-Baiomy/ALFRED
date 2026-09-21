import { Component, DestroyRef, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { interval } from 'rxjs';
import {
  FAILURE_HINTS,
  FAILURE_OPTIONS,
  FailureMode,
  GATEWAY_STATUSES,
  PauseCycle,
  PauseDecision,
  PauseStage,
  PausedCall,
} from '../../core/models/interception.model';
import { InterceptionStateService } from '../../core/state/interception-state.service';
import { StatusPickerComponent } from '../status-picker/status-picker.component';
import { SelectPickerComponent } from '../select-picker/select-picker.component';
import { JsonFlatViewComponent, LineTokens } from '../json-flat-view/json-flat-view.component';
import { JsonTokensComponent } from '../../shared/components/json-tokens/json-tokens.component';
import { highlightTokens, tokenizeJsonText } from '../../shared/utils/json-tokenizer';
import { tokenizeXmlText } from '../../shared/utils/xml-tokenizer';
import { splitTokensIntoLines } from '../../shared/utils/line-tokenizer';
import {
  BodyKind,
  LIVE_CHECK_LIMIT,
  detectBodyKind,
  findMatches,
  formatBody,
  minifyBody,
  normalizeBody,
  validateBody,
} from '../../shared/utils/body-format';

/** One editable header row. `removed` keeps the row on screen, struck through, rather than vanishing. */
export interface EditableHeader {
  name: string;
  value: string;
  removed: boolean;
  /** Added by hand rather than sent by the client or the host. */
  added: boolean;
}

type Tab = 'response' | 'request' | 'headers';

/** How a card's outcome reads in the strip at the top of a finished call. */
const OUTCOMES: Record<string, string> = {
  completed: 'Cycle complete',
  aborted: 'You aborted this call',
  failed: 'The call failed before it finished',
  'never-came-back': 'No answer ever arrived',
};

/** Edit it, or read it the way the call cards render a body. */
type BodyMode = 'edit' | 'inspect';

/**
 * The breakpoint inspector: calls the proxy is holding open while somebody decides what happens to
 * them.
 *
 * The thing to keep in mind when changing anything here is that every row on this screen is a real
 * client socket held open right now. That is why the countdown is prominent rather than tucked into
 * a corner, why "send unchanged" is as easy to reach as "send edited", and why the component keeps
 * a local 1-second ticker: the deadline is real and a stale timer would misrepresent how long is
 * left to decide.
 *
 * The ticker is the one timer in the app and it is not polling - it re-renders a countdown from
 * data already in hand and makes no requests. The list itself still arrives by WebSocket push, like
 * everything else (see docs/frontend-architecture.md).
 */
@Component({
  selector: 'app-paused-calls',
  standalone: true,
  imports: [StatusPickerComponent, SelectPickerComponent, JsonFlatViewComponent, JsonTokensComponent],
  templateUrl: './paused-calls.component.html',
})
export class PausedCallsComponent {
  readonly state = inject(InterceptionStateService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly bodyArea = viewChild<ElementRef<HTMLTextAreaElement>>('bodyArea');
  private readonly gutter = viewChild<ElementRef<HTMLElement>>('gutter');
  private readonly highlight = viewChild<ElementRef<HTMLElement>>('highlight');

  private readonly selectedId = signal<string | null>(null);
  readonly tab = signal<Tab>('response');

  /** Re-read every second so the countdown moves; holds no data of its own. */
  private readonly tick = signal(Date.now());

  /** Which call the current edits belong to - see the effect in the constructor. */
  private editingCallId: string | null = null;

  /** The body as the user has edited it, or null while it is still exactly what came back. */
  readonly editedBody = signal<string | null>(null);
  readonly editedStatus = signal<number | null>(null);
  /** Null while the headers are untouched - the same "only send what changed" rule as the body. */
  readonly editedHeaders = signal<EditableHeader[] | null>(null);
  readonly busy = signal(false);

  readonly bodyMode = signal<BodyMode>('edit');

  /**
   * Stop this call a second time when the supplier answers.
   *
   * Off by default, because it holds a real caller twice. It is NOT what keeps the card on
   * screen - that happens for every call you decide on - so leaving it alone still shows you the
   * whole cycle, just without a second stop.
   */
  readonly follow = signal(false);
  readonly query = signal('');
  readonly matchIndex = signal(0);

  /** The paste-everything box, open only while it is being used. */
  readonly replaceOpen = signal(false);
  readonly replaceText = signal('');
  readonly replaceError = signal<string | null>(null);

  /**
   * "Mock a network failure instead" - the SAME SIMULATE_FAILURE action a rule already has,
   * reused rather than reinvented, so the caller experiences exactly the modes the rule editor
   * already documents (see FAILURE_OPTIONS/FAILURE_HINTS) whether a rule chose one ahead of time
   * or a human chooses one here, by hand, while looking at a real call.
   */
  readonly failureOpen = signal(false);
  readonly failureMode = signal<FailureMode>('CONNECTION_RESET');
  readonly failureDurationMs = signal(30000);
  readonly failureStatus = signal(504);
  readonly failureBody = signal('');
  readonly failureOptions = FAILURE_OPTIONS;
  readonly gatewayStatuses = GATEWAY_STATUSES;

  readonly selected = computed<PausedCall | null>(() => {
    const calls = this.state.pausedCalls();
    if (calls.length === 0) return null;
    return calls.find((c) => c.callId === this.selectedId()) ?? calls[0];
  });

  // ---- what this card is, and what can be done to it ---------------------------------------
  //
  // A card outlives the half it was paused on. It holds a caller, then it is in flight while the
  // supplier works, then it is finished and only waiting to be read. Only the first of those can
  // be edited, and only on the one half that is actually being held - so "which half am I
  // looking at" and "can I change it" became two different questions here, where they used to be
  // the same one.

  readonly stage = computed<PauseStage>(() => this.selected()?.stage ?? 'holding');

  /** Whether a real client socket is open on the other end of the selected card. */
  readonly holding = computed(() => this.stage() === 'holding');

  readonly cycle = computed<PauseCycle | null>(() => this.selected()?.cycle ?? null);

  /** The tab showing the half this call is paused on - the only one that can be edited. */
  readonly editableTab = computed<Tab>(() => (this.selected()?.phase === 'response' ? 'response' : 'request'));

  /** Whether the body and headers on screen right now accept edits. */
  readonly editable = computed(() => this.holding() && this.tab() === this.editableTab());

  /** Which half the tabs are showing. A finished card has both, and both are worth reading. */
  readonly shownHttp = computed(() => {
    const call = this.selected();
    if (!call) return null;
    return this.tab() === 'request' ? call.request ?? null : call.response ?? null;
  });

  /** Which half the user is deciding about, or null when nothing is being decided. */
  readonly editableHttp = computed(() => {
    const call = this.selected();
    if (!call || !this.holding()) return null;
    return call.phase === 'response' ? call.response ?? null : call.request ?? null;
  });

  /** A finished card has a response worth its own tab even when the pause was on the request. */
  readonly hasResponse = computed(() => this.selected()?.response != null);

  readonly originalBody = computed(() => this.shownHttp()?.body ?? '');
  readonly originalStatus = computed(() => this.editableHttp()?.status ?? null);

  readonly outcomeLabel = computed(() => {
    const outcome = this.cycle()?.outcome;
    return outcome ? OUTCOMES[outcome] ?? outcome : '';
  });

  readonly durationLabel = computed(() => this.durationOf(this.selected()));

  /** How long the caller waited, end to end. Seconds once "108735ms" stops being readable. */
  durationOf(call: PausedCall | null | undefined): string {
    const ms = call?.cycle?.durationMs;
    if (ms == null) return '';
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
  }

  /** How long this call has been away upstream - the in-flight card's only moving part. */
  inFlightFor(call: PausedCall): string {
    const since = call.cycle?.releasedAt;
    if (since == null) return '';
    return `${((this.tick() - since) / 1000).toFixed(1)}s`;
  }

  /**
   * What kind of body this is, decided by the same functions the call panel uses so a payload is
   * classified identically in both places.
   */
  readonly bodyKind = computed<BodyKind>(() => detectBodyKind(this.editedBody() ?? this.originalBody()));

  /**
   * The body as shown - pretty-printed on arrival, because a 4 KB payload on one line cannot be
   * read, let alone edited.
   *
   * Formatting is NOT an edit: `dirty` compares the two sides normalised, so reformatting alone
   * leaves the call untouched and "Send unchanged" still puts the supplier's original bytes on
   * the wire. That property is worth protecting - it is what makes pausing a call free.
   */
  readonly currentBody = computed(() => {
    // An edit belongs to the half being HELD, not to whichever half is on screen - otherwise
    // opening the "Request sent" tab of a held response would show the response edit over the
    // request's body.
    const edited = this.editable() ? this.editedBody() : null;
    if (edited !== null) return edited;
    const original = this.originalBody();
    return formatBody(original, detectBodyKind(original)) ?? original;
  });
  readonly currentStatus = computed(() => this.editedStatus() ?? this.originalStatus());

  /** Substance, not layout - see normalizeBody. Always about the held half, whatever tab is open. */
  readonly bodyEdited = computed(() => {
    const edited = this.editedBody();
    if (edited === null) return false;
    const original = this.editableHttp()?.body ?? '';
    const kind = detectBodyKind(edited);
    return normalizeBody(edited, kind) !== normalizeBody(original, kind);
  });

  readonly dirty = computed(
    () =>
      this.bodyEdited() ||
      (this.editedStatus() !== null && this.editedStatus() !== this.originalStatus()) ||
      this.headerChangeCount() > 0
  );

  /** The header rows as they stand - the call's own, or the working copy once anything is edited. */
  readonly headerRows = computed<EditableHeader[]>(() => {
    const edited = this.editedHeaders();
    if (edited) return edited;
    const headers = this.editableHttp()?.headers ?? {};
    return Object.entries(headers).map(([name, value]) => ({ name, value, removed: false, added: false }));
  });

  /**
   * What to actually send: only the headers that differ from what arrived.
   *
   * A null VALUE removes that header - the wire contract apply_decision already implements - and
   * an absent key leaves it alone. Sending the whole set every time would rewrite forty headers
   * to change one, and would stop an untouched release being byte-identical to never pausing.
   */
  readonly headerChanges = computed<Record<string, string | null>>(() => {
    const edited = this.editedHeaders();
    if (!edited) return {};
    const original = this.editableHttp()?.headers ?? {};
    const changes: Record<string, string | null> = {};
    for (const row of edited) {
      if (!row.name.trim()) continue;
      if (row.removed) {
        if (row.name in original) changes[row.name] = null;
      } else if (original[row.name] !== row.value) {
        changes[row.name] = row.value;
      }
    }
    // A header that was in the original and is no longer in the list at all was deleted outright.
    const kept = new Set(edited.filter((r) => !r.removed).map((r) => r.name));
    for (const name of Object.keys(original)) {
      if (!kept.has(name)) changes[name] = null;
    }
    return changes;
  });

  readonly headerChangeCount = computed(() => Object.keys(this.headerChanges()).length);

  /** Read-only header rows for a card nobody can edit any more - both halves, side by side. */
  readonly shownHeaderRows = computed(() => {
    const call = this.selected();
    const groups: { title: string; rows: { name: string; value: string }[] }[] = [];
    const add = (title: string, headers: Record<string, string> | null | undefined) => {
      if (headers && Object.keys(headers).length > 0) {
        groups.push({ title, rows: Object.entries(headers).map(([name, value]) => ({ name, value })) });
      }
    };
    add('Request', call?.request?.headers);
    add('Response', call?.response?.headers);
    return groups;
  });

  // ---- reading and searching the body ----------------------------------------------------

  readonly validity = computed(() => validateBody(this.currentBody(), this.bodyKind()));

  readonly canFormat = computed(() => formatBody(this.currentBody(), this.bodyKind()) !== null);

  readonly bodyStats = computed(() => {
    const text = this.currentBody();
    if (!text) return '';
    const lines = text.split('\n').length;
    const kb = (new Blob([text]).size / 1024).toFixed(1);
    return `${lines.toLocaleString()} ${lines === 1 ? 'line' : 'lines'} · ${kb} KB`;
  });

  /** One number per line, for the gutter beside the textarea. */
  readonly lineNumbers = computed(() =>
    Array.from({ length: this.currentBody().split('\n').length }, (_, i) => i + 1)
  );

  readonly matches = computed(() => findMatches(this.currentBody(), this.query()));

  readonly matchLabel = computed(() => {
    const total = this.matches().length;
    if (!this.query()) return '';
    return total === 0 ? 'no matches' : `${Math.min(this.matchIndex() + 1, total)}/${total}`;
  });

  /**
   * The same tokenize → highlight → split pipeline the call cards run, so neither the editor nor
   * Inspect is a lookalike of that view - they render the very tokens it renders, told which
   * tokenizer to use. One computed feeds both layers, so the coloured text behind the caret and
   * the read-only view can never disagree about what a body says.
   */
  private readonly tokenizedLines = computed<readonly LineTokens[]>(() => {
    const text = this.currentBody();
    const tokens = this.bodyKind() === 'xml' ? tokenizeXmlText(text) : tokenizeJsonText(text);
    const highlighted = highlightTokens(tokens, this.query()).tokens;
    return splitTokensIntoLines(highlighted).map((tokensOnLine, index) => ({ index, tokens: tokensOnLine }));
  });

  /**
   * A half nobody can change is always shown in Inspect, whatever the Edit/Inspect buttons last
   * said. It is the call cards' own view, so reading the request you already sent or the response
   * that came back gets the same colouring, line numbers and search as editing one - rather than
   * the flat grey <pre> this used to drop to.
   */
  readonly effectiveMode = computed<BodyMode>(() => (this.editable() ? this.bodyMode() : 'inspect'));

  readonly inspectLines = computed<readonly LineTokens[]>(() =>
    this.effectiveMode() === 'inspect' ? this.tokenizedLines() : []
  );

  /**
   * Whether the editor paints coloured text behind the caret.
   *
   * Off past the same size limit the validity check uses, and for the same reason: re-tokenizing
   * a 6 MB body on every keystroke would make typing unusable, which is a worse failure than
   * monochrome text. Inspect still renders it, because that view is windowed.
   */
  readonly overlayEnabled = computed(() => this.currentBody().length <= LIVE_CHECK_LIMIT);

  readonly editorLines = computed<readonly LineTokens[]>(() =>
    this.effectiveMode() === 'edit' && this.overlayEnabled() ? this.tokenizedLines() : []
  );

  /** Plain text gets no syntax colouring - pretending otherwise would colour a SOAP fault as JSON. */
  readonly inspectVariant = computed(() => (this.bodyKind() === 'text' ? 'plain' : 'json'));

  /** Which match the flat view should mark as current, counted the way that component counts them. */
  readonly activeMatch = computed(() => (this.matches().length === 0 ? -1 : this.matchIndex()));

  constructor() {
    interval(1000)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.tick.set(Date.now()));

    // Selecting a different call must drop any half-finished edit, or a body typed for one call
    // would be released against another.
    //
    // Keyed on the call ID, NOT the object. The list is re-fetched whenever anything about a
    // paused call changes - including when editing claims it - so the same call arrives as a new
    // object seconds after you start typing. Watching identity meant the FIRST edit to an
    // unclaimed call was always thrown away: the edit triggered the claim, the claim refreshed
    // the list, and the refresh wiped the edit. Caught on live traffic, where a header change
    // vanished and only the second one survived.
    // Keyed on the call id AND its phase. A followed call comes back to this screen as the same
    // id on its other half - same card, same place in the queue - and an edit typed into the
    // request must not be carried over onto the response that answered it.
    effect(
      () => {
        const call = this.selected();
        const key = call ? `${call.callId}:${call.phase}` : null;
        if (key === this.editingCallId) return;
        this.editingCallId = key;
        this.editedBody.set(null);
        this.editedStatus.set(null);
        this.editedHeaders.set(null);
        this.replaceOpen.set(false);
        this.replaceText.set('');
        this.replaceError.set(null);
        this.failureOpen.set(false);
        this.query.set('');
        this.matchIndex.set(0);
        this.bodyMode.set('edit');
        this.follow.set(false);
        // Not only when the user clicks a row: a call auto-selected because it is first in the
        // queue, and the answer to a call you were following arriving on its other half, both
        // land here too, and both need the tab pointed at the half that now matters.
        if (call) this.tab.set(this.defaultTab(call));
      },
      { allowSignalWrites: true }
    );
  }

  select(call: PausedCall): void {
    this.selectedId.set(call.callId);
    this.tab.set(this.defaultTab(call));
  }

  /** A live card opens on the half you have to decide about; a finished one on its answer. */
  private defaultTab(call: PausedCall): Tab {
    if ((call.stage ?? 'holding') === 'holding') {
      return call.phase === 'response' ? 'response' : 'request';
    }
    return call.response ? 'response' : 'request';
  }

  /** Which stage a row in the queue is in, tolerating a payload from a proxy that predates them. */
  stageOf(call: PausedCall): PauseStage {
    return call.stage ?? 'holding';
  }

  closable(call: PausedCall): boolean {
    return this.stageOf(call) !== 'holding';
  }

  /**
   * Dismisses one card. Only ever offered for a call that holds nobody - closing a card whose
   * caller is still waiting would orphan a real socket, and the backend refuses it too.
   */
  close(call: PausedCall): void {
    if (this.busy() || !this.closable(call)) return;
    this.busy.set(true);
    if (this.selectedId() === call.callId) this.selectedId.set(null);
    this.state.closeCard(call.callId).subscribe({
      next: () => this.busy.set(false),
      error: () => {
        this.busy.set(false);
        this.state.refreshPaused();
      },
    });
  }

  closeFinished(): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.state.closeFinished().subscribe({
      next: () => this.busy.set(false),
      error: () => this.busy.set(false),
    });
  }

  onFollowChange(event: Event): void {
    this.follow.set((event.target as HTMLInputElement).checked);
  }

  /**
   * Editing anything implies you are at the screen, so the clock stops on first keystroke rather
   * than waiting for the button to be pressed - a body edited under a running countdown is the
   * exact case this feature exists to prevent.
   */
  private claimOnEdit(): void {
    const call = this.selected();
    if (call && !this.held(call)) this.takeControl(call);
  }

  isSelected(call: PausedCall): boolean {
    return this.selected()?.callId === call.callId;
  }

  /**
   * Whole seconds left before the proxy gives up and applies the rule's own timeout action.
   *
   * Only meaningful while the call is merely paused: the countdown is a grace period for somebody
   * to NOTICE it, and once control has been taken it stops entirely (see held/heldFor).
   */
  secondsLeft(call: PausedCall): number {
    const remaining = call.pausedAt + call.timeoutSeconds * 1000 - this.tick();
    return Math.max(0, Math.ceil(remaining / 1000));
  }

  held(call: PausedCall): boolean {
    return call.heldAt != null;
  }

  /** How long a held call has been waiting on you - counts UP, because nothing is expiring. */
  heldFor(call: PausedCall): string {
    const seconds = Math.max(0, Math.floor((this.tick() - (call.heldAt ?? 0)) / 1000));
    const minutes = Math.floor(seconds / 60);
    return minutes > 0 ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
  }

  urgent(call: PausedCall): boolean {
    return !this.held(call) && this.secondsLeft(call) <= 10;
  }

  takeControl(call: PausedCall): void {
    if (this.held(call) || this.busy()) return;
    this.busy.set(true);
    this.state.takeControl(call.callId).subscribe({
      next: () => this.busy.set(false),
      error: () => {
        this.busy.set(false);
        this.state.refreshPaused();
      },
    });
  }

  timeoutLabel(call: PausedCall): string {
    return call.onTimeout === 'abort' ? 'aborts' : 'releases unchanged';
  }

  onBodyInput(event: Event): void {
    this.editedBody.set((event.target as HTMLTextAreaElement).value);
    this.claimOnEdit();
  }

  format(): void {
    const formatted = formatBody(this.currentBody(), this.bodyKind());
    // Only ever null when the body cannot be parsed, and the button is disabled then - but a
    // keyboard or a race should not blank somebody's body.
    if (formatted !== null) this.editedBody.set(formatted);
  }

  minify(): void {
    const minified = minifyBody(this.currentBody(), this.bodyKind());
    if (minified !== null) this.editedBody.set(minified);
  }

  onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.matchIndex.set(0);
    this.revealMatch();
  }

  step(delta: number): void {
    const total = this.matches().length;
    if (total === 0) return;
    this.matchIndex.set((this.matchIndex() + delta + total) % total);
    this.revealMatch();
  }

  setBodyMode(mode: BodyMode): void {
    this.bodyMode.set(mode);
    this.revealMatch();
  }

  /**
   * Puts the current match on screen. In Edit that means selecting it in the textarea, which is
   * the only way to point at a position inside one - a textarea cannot carry highlight marks.
   * Inspect does its own highlighting, so there is nothing to do but let it scroll.
   */
  private revealMatch(): void {
    if (this.bodyMode() !== 'edit') return;
    const at = this.matches()[this.matchIndex()];
    if (at === undefined) return;
    const area = this.bodyArea()?.nativeElement;
    if (!area) return;
    area.focus();
    area.setSelectionRange(at, at + this.query().length);
    // Roughly centre the line: a textarea has no scrollIntoView for a character offset.
    const line = this.currentBody().slice(0, at).split('\n').length - 1;
    const lineHeight = area.scrollHeight / Math.max(1, this.currentBody().split('\n').length);
    area.scrollTop = Math.max(0, line * lineHeight - area.clientHeight / 2);
    this.syncGutter();
  }

  /**
   * The gutter and the coloured layer are separate elements, so both have to be told where the
   * textarea scrolled to. The overlay needs BOTH axes: the textarea does not wrap, and a
   * horizontal scroll that moved only the caret would slide the text out from under it.
   */
  syncGutter(): void {
    const area = this.bodyArea()?.nativeElement;
    if (!area) return;
    const gutter = this.gutter()?.nativeElement;
    if (gutter) gutter.scrollTop = area.scrollTop;
    const highlight = this.highlight()?.nativeElement;
    if (highlight) {
      highlight.scrollTop = area.scrollTop;
      highlight.scrollLeft = area.scrollLeft;
    }
  }

  onStatusChange(status: number): void {
    this.editedStatus.set(status);
    this.claimOnEdit();
  }

  /** Starts a working copy on first edit, so an untouched call still sends nothing. */
  private workingHeaders(): EditableHeader[] {
    const existing = this.editedHeaders();
    if (existing) return existing;
    const headers = this.editableHttp()?.headers ?? {};
    return Object.entries(headers).map(([name, value]) => ({ name, value, removed: false, added: false }));
  }

  onHeaderName(index: number, event: Event): void {
    const name = (event.target as HTMLInputElement).value;
    this.editedHeaders.set(this.workingHeaders().map((row, i) => (i === index ? { ...row, name } : row)));
    this.claimOnEdit();
  }

  onHeaderValue(index: number, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.editedHeaders.set(this.workingHeaders().map((row, i) => (i === index ? { ...row, value } : row)));
    this.claimOnEdit();
  }

  /**
   * Removing keeps the row, struck through and undoable. A row that simply vanished would leave
   * "did I delete content-type, or was it never there" unanswerable on a call being held open.
   */
  toggleHeaderRemoved(index: number): void {
    this.editedHeaders.set(
      this.workingHeaders()
        .map((row, i) => (i === index ? { ...row, removed: !row.removed } : row))
        // A row added by hand and then removed never existed, so it goes entirely.
        .filter((row) => !(row.added && row.removed))
    );
    this.claimOnEdit();
  }

  addHeader(): void {
    this.editedHeaders.set([...this.workingHeaders(), { name: '', value: '', removed: false, added: true }]);
    this.claimOnEdit();
  }

  toggleReplace(): void {
    const opening = !this.replaceOpen();
    if (opening) {
      // Seeded with what is actually there, so "replace everything" starts from the truth rather
      // than an empty box somebody has to reconstruct a live call inside.
      this.replaceText.set(
        JSON.stringify(
          {
            ...(this.selected()?.phase === 'response' ? { status: this.currentStatus() } : {}),
            headers: Object.fromEntries(
              this.headerRows().filter((r) => !r.removed).map((r) => [r.name, r.value])
            ),
            body: this.currentBody(),
          },
          null,
          2
        )
      );
      this.replaceError.set(null);
    }
    this.replaceOpen.set(opening);
  }

  onReplaceText(event: Event): void {
    this.replaceText.set((event.target as HTMLTextAreaElement).value);
    this.replaceError.set(null);
  }

  /**
   * Applies a pasted {status, headers, body} wholesale. Anything left out of `headers` is
   * REMOVED rather than kept - a "replace everything" that quietly preserved what you deleted is
   * the one thing this control must not do.
   */
  applyReplacement(): void {
    let parsed: { status?: unknown; headers?: unknown; body?: unknown };
    try {
      parsed = JSON.parse(this.replaceText()) as typeof parsed;
    } catch (e) {
      this.replaceError.set(`That is not valid JSON: ${(e as Error).message}`);
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      this.replaceError.set('Expected an object with status, headers and body.');
      return;
    }

    const headers = parsed.headers;
    if (headers !== undefined && (typeof headers !== 'object' || headers === null || Array.isArray(headers))) {
      this.replaceError.set('headers must be an object of name to value.');
      return;
    }

    if (headers !== undefined) {
      const original = this.editableHttp()?.headers ?? {};
      const replacement: EditableHeader[] = Object.entries(headers as Record<string, unknown>).map(
        ([name, value]) => ({ name, value: String(value), removed: false, added: !(name in original) })
      );
      // Everything the paste left out is explicitly gone, not quietly kept.
      const kept = new Set(replacement.map((r) => r.name));
      for (const [name, value] of Object.entries(original)) {
        if (!kept.has(name)) replacement.push({ name, value, removed: true, added: false });
      }
      this.editedHeaders.set(replacement);
    }

    if (typeof parsed.body === 'string') this.editedBody.set(parsed.body);
    if (typeof parsed.status === 'number') this.editedStatus.set(parsed.status);

    this.replaceOpen.set(false);
    this.claimOnEdit();
  }

  revert(): void {
    this.editedBody.set(null);
    this.editedStatus.set(null);
    this.editedHeaders.set(null);
    this.replaceOpen.set(false);
    this.replaceError.set(null);
    this.failureOpen.set(false);
  }

  /**
   * A release carries ONLY what was actually changed. Sending the untouched body back would mean
   * the proxy rewrites it - re-serialising a payload that may be megabytes, and turning "send
   * unchanged" into something subtly different from never having paused at all.
   */
  release(edited: boolean): void {
    const call = this.selected();
    if (!call || this.busy()) return;
    const headers = this.headerChanges();
    // Spread rather than a `follow: undefined` property. An unchanged release must carry the
    // action and NOTHING else - that is what keeps it byte-identical to never having paused, and
    // a key that happens to be undefined is still a key in the payload.
    const follow = call.phase !== 'response' && this.follow() ? { follow: true } : {};
    const decision: PauseDecision = edited
      ? {
          action: 'release',
          headers: Object.keys(headers).length > 0 ? headers : null,
          // What you see is what is sent - including its formatting. When nothing really
          // changed this is null, so an untouched release stays byte-identical to the original.
          body: this.bodyEdited() ? this.editedBody() : null,
          status:
            this.editedStatus() !== null && this.editedStatus() !== this.originalStatus() ? this.editedStatus() : null,
          ...follow,
        }
      : { action: 'release', ...follow };
    this.send(call, decision);
  }

  abort(): void {
    const call = this.selected();
    if (!call || this.busy()) return;
    this.send(call, { action: 'abort' });
  }

  toggleFailure(): void {
    const opening = !this.failureOpen();
    if (opening) {
      // Seeded with what is actually on screen, the same idea toggleReplace() already uses for
      // its own panel - a body to cut short starts from the real one instead of a blank box.
      this.failureMode.set('CONNECTION_RESET');
      this.failureDurationMs.set(30000);
      this.failureStatus.set(504);
      this.failureBody.set(this.currentBody());
    }
    this.failureOpen.set(opening);
  }

  onFailureModeChange(value: string): void {
    this.failureMode.set(value as FailureMode);
  }

  failureHint(): string {
    return FAILURE_HINTS[this.failureMode()];
  }

  needsHangDuration(): boolean {
    return this.failureMode() === 'HANG_THEN_DROP';
  }

  needsGatewayStatus(): boolean {
    return this.failureMode() === 'GATEWAY_ERROR';
  }

  needsTruncatedBody(): boolean {
    return this.failureMode() === 'TRUNCATED_BODY';
  }

  onFailureDuration(event: Event): void {
    this.failureDurationMs.set(Number((event.target as HTMLInputElement).value) || 0);
  }

  onFailureBody(event: Event): void {
    this.failureBody.set((event.target as HTMLTextAreaElement).value);
  }

  /**
   * Resolves the pause by reproducing a network failure instead of releasing or plainly aborting -
   * the exact same SIMULATE_FAILURE the rule editor offers ahead of time, chosen here for one call
   * a human is already looking at. Only the field the chosen mode actually reads is sent, same
   * reasoning as release(): a stale duration/status/body left over from switching modes must not
   * be saved and then silently ignored.
   */
  simulateFailure(): void {
    const call = this.selected();
    if (!call || this.busy()) return;
    const mode = this.failureMode();
    this.send(call, {
      action: 'simulate_failure',
      failure: {
        mode,
        durationMs: mode === 'HANG_THEN_DROP' ? this.failureDurationMs() : null,
        status: mode === 'GATEWAY_ERROR' ? this.failureStatus() : null,
        body: mode === 'TRUNCATED_BODY' ? this.failureBody() : null,
      },
    });
  }

  releaseAll(): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.state.releaseAll().subscribe({
      next: () => this.busy.set(false),
      error: () => this.busy.set(false),
    });
  }

  private send(call: PausedCall, decision: PauseDecision): void {
    this.busy.set(true);
    this.state.decide(call.callId, decision).subscribe({
      next: () => {
        this.busy.set(false);
        this.revert();
      },
      // A 404 means this call stopped waiting while the user was deciding - its timeout fired, or
      // another tab answered it. Refreshing is the whole remedy; there is nothing left to act on.
      error: () => {
        this.busy.set(false);
        this.state.refreshPaused();
      },
    });
  }

  trackByCallId(_: number, call: PausedCall): string {
    return call.callId;
  }
}
