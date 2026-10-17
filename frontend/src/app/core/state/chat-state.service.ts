import { BoardApiService } from '../services/board-api.service';
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable, Subject, auditTime, buffer, filter } from 'rxjs';
import { LiveWork, MentionRef } from '../models/board.models';
import { SessionCycle } from '../models/call.model';
import { ChatMessage, ChatSummary, ChatView, NewChatMessage, PROJECT_SCOPE, foldedIds } from '../models/chat.models';
import { BoardSocketService } from '../services/board-socket.service';
import { ChatApiService } from '../services/chat-api.service';
import { SessionCyclesApiService } from '../services/session-cycles-api.service';
import { LiveWorkStateService } from './live-work-state.service';
import { messageOf } from './board-state.service';
import { unreadOf } from '../../shared/utils/chat-queue';
import { chatScopeFor, withChip, withoutChip } from '../../shared/utils/chat-context';
import { BarRow, ChatMute, barRows, totalUnread } from '../../shared/utils/chat-bar';

/** The newest page of one chat, oldest first, and whether older messages wait behind it. */
export interface ChatThread {
  readonly scope: string;
  readonly messages: readonly ChatMessage[];
  readonly more: boolean;
}

export type { BarRow, ChatMute } from '../../shared/utils/chat-bar';

const PREFS = 'alfred.chat.prefs';
const SEEN = 'alfred.chat.seen';
const LOOKED = 'alfred.chat.looked';
const DRAFT = 'alfred.board.draft.chat:';

interface Prefs {
  view: ChatView;
  width: number;
  slim: boolean;
  /** Where the floating chats pill sits (dragged there; remembered). */
  side: 'right' | 'left';
  mute: Record<string, ChatMute>;
  notify: boolean;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: kept for this visit only */ }
}

/**
 * The board chats' state (specs/022): the bar's rows for the project, the open chat, the page of each chat the user
 * opened, and this viewer's own conveniences (view, width, unread marks, mute) - those in localStorage, wrapped so a
 * browser without it still works. Fetch-on-demand: one fetch on open, then one per /ws/board `chat-changed` - no timers.
 */
@Injectable({ providedIn: 'root' })
export class ChatStateService {
  private readonly api = inject(ChatApiService);
  private readonly live = inject(LiveWorkStateService);
  private readonly cyclesApi = inject(SessionCyclesApiService);
  private readonly boardsApi = inject(BoardApiService);
  private readonly changed$ = new Subject<string | null>();
  private shown = false;

  readonly project = signal('');
  /** The cycle the user is looking at (a cycle board or page) - the panel follows it when no chat was picked. */
  readonly cycleInView = signal<string | null>(null);
  readonly summaries = signal<readonly ChatSummary[]>([]);
  readonly cycles = signal<readonly SessionCycle[]>([]);
  readonly openScope = signal<string | null>(null);
  readonly threads = signal<ReadonlyMap<string, ChatThread>>(new Map());
  readonly error = signal<string | null>(null);
  /** A message to scroll to and flash (a chat mention, a search hit). */
  readonly focusId = signal<number | null>(null);
  readonly prefs = signal<Prefs>(readJson<Prefs>(PREFS, { view: 'docked', width: 440, slim: false, side: 'right', mute: {}, notify: false }));
  readonly seen = signal<Record<string, number>>(readJson<Record<string, number>>(SEEN, {}));
  /** Bumped when a draft is saved or cleared, so the bar re-reads its draft marks. */
  readonly draftsVersion = signal(0);

  readonly view = computed(() => this.prefs().view);
  readonly open = computed<ChatThread | null>(() => {
    const scope = this.openScope();
    return scope == null ? null : this.threads().get(scope) ?? null;
  });
  readonly openSummary = computed(() => this.summaries().find((s) => s.scope === this.openScope()) ?? null);
  readonly folded = computed<ReadonlySet<number>>(() => foldedIds(this.open()?.messages ?? []));
  /** The run answering each chat message, by message id (the live steps under it). */
  readonly workByMessage = computed<ReadonlyMap<number, LiveWork>>(() => {
    const out = new Map<number, LiveWork>();
    for (const w of this.live.all()) if (w.chatMessageId != null) out.set(w.chatMessageId, w);
    return out;
  });
  /** Chat names by scope: a board chat's scope is its board id (specs/027), an older one a cycle id. */
  private readonly boardNames = signal<ReadonlyMap<string, string>>(new Map());
  readonly cycleNames = computed(() => new Map([...this.cycles().map((c) => [c.id, c.name] as const), ...this.boardNames()]));
  readonly rows = computed<BarRow[]>(() => {
    this.draftsVersion();
    return barRows({ project: this.project(), summaries: this.summaries(), inView: this.cycleInView(), seen: this.seen(), mute: this.prefs().mute,
      names: this.cycleNames(), hasDraft: (key) => this.hasDraft(key), unreadIn: (scope, lastSeen) => this.unreadIn(scope, lastSeen) });
  });
  readonly totalUnread = computed(() => totalUnread(this.rows()));

  constructor() {
    const destroyRef = inject(DestroyRef);
    const socket = inject(BoardSocketService);
    // Several signals in a burst (a reply with records) become one re-read per chat they named.
    this.changed$.pipe(buffer(this.changed$.pipe(auditTime(150))), takeUntilDestroyed(destroyRef)).subscribe((scopes) => this.reload(scopes));
    socket.events$.pipe(
      filter((e) => e.type === 'chat-changed' && e.project === this.project()),
      takeUntilDestroyed(destroyRef),
    ).subscribe((e) => this.changed$.next(e.type === 'chat-changed' ? e.scope : null));
    socket.reconnected$.pipe(takeUntilDestroyed(destroyRef)).subscribe(() => this.changed$.next(null));
  }

  /** The bar of a project: its chats' rows. Switching project forgets the other project's pages. */
  show(project: string, cycleId: string | null = null): void {
    if (project !== this.project() || !this.shown) {
      this.shown = true;
      this.project.set(project);
      this.threads.set(new Map());
      this.openScope.set(null);
      this.splitScope.set(null);
      this.tabs.set([]);
      this.loadSummaries();
      if (!this.cycles().length) this.loadCycles();
    }
    this.cycleInView.set(cycleId);
  }

  /** The chat list above the floating pill is open. */
  readonly listOpen = signal(false);
  /** Chats folded to tabs beside the pill (– on a chat window), newest first. */
  readonly tabs = signal<readonly string[]>([]);

  openChat(scope: string | null, focusId: number | null = null): void {
    this.listOpen.set(false);
    if (scope != null) {
      this.tabs.update((t) => t.filter((x) => x !== scope));
      if (scope === this.splitScope()) this.splitScope.set(null);
    }
    this.openScope.set(scope);
    this.focusId.set(focusId);
    if (scope == null) return;
    if (!this.threads().has(scope)) this.loadPage(scope);
    if (!this.cycleNames().has(scope) && scope !== PROJECT_SCOPE) this.loadCycles();
  }

  close(): void {
    this.openScope.set(this.splitScope());
    this.splitScope.set(null);
  }

  /** – folds a chat window to a tab beside the pill; a click on the tab opens it again. */
  minimize(scope: string): void {
    this.tabs.update((t) => [scope, ...t.filter((x) => x !== scope)].slice(0, 4));
    if (scope === this.splitScope()) this.splitScope.set(null);
    else if (scope === this.openScope()) this.close();
  }

  closeTab(scope: string): void {
    this.tabs.update((t) => t.filter((x) => x !== scope));
  }

  /** ◫ A second chat beside the first (FR-047), with its own send box. */
  readonly splitScope = signal<string | null>(null);

  openSplit(scope: string): void {
    if (scope === this.openScope()) return;
    this.tabs.update((t) => t.filter((x) => x !== scope));
    this.splitScope.set(scope);
    if (!this.threads().has(scope)) this.loadPage(scope);
  }

  closeSplit(): void {
    this.splitScope.set(null);
  }

  /** ⇆ The second chat becomes the main one. */
  swapSplit(): void {
    const second = this.splitScope();
    if (second == null) return;
    this.splitScope.set(this.openScope());
    this.openScope.set(second);
  }

  /** A write from this browser changed a chat - re-read it now rather than wait for the signal. */
  changedLocally(scope: string): void {
    this.changed$.next(scope);
  }

  /** What the user is looking at, per `project/scope`, sent with the next message as removable chips (FR-020). */
  readonly chips = signal<ReadonlyMap<string, readonly MentionRef[]>>(new Map());

  chipsOf(scope: string): readonly MentionRef[] {
    return this.chips().get(`${this.project()}/${scope}`) ?? [];
  }

  /**
   * "Ask Claude" on a call, a statement or a log line (FR-021): the item's cycle chat when it is in a cycle, else the
   * project chat, opened in place with the item attached.
   */
  ask(project: string, cycleId: string | null, chip: MentionRef): void {
    if (project !== this.project() || !this.shown) this.show(project, cycleId);
    const scope = chatScopeFor(cycleId);
    const key = `${project}/${scope}`;
    this.chips.update((m) => new Map(m).set(key, withChip(m.get(key) ?? [], chip)));
    this.openChat(scope);
  }

  removeChip(scope: string, chip: MentionRef): void {
    const key = `${this.project()}/${scope}`;
    this.chips.update((m) => new Map(m).set(key, withoutChip(m.get(key) ?? [], chip)));
  }

  clearChips(scope: string): void {
    const key = `${this.project()}/${scope}`;
    this.chips.update((m) => { const next = new Map(m); next.delete(key); return next; });
  }

  /** The page before the oldest loaded message. */
  loadOlder(scope: string): void {
    const thread = this.threads().get(scope);
    if (!thread?.more || !thread.messages.length) return;
    this.api.messages(this.project(), scope, thread.messages[0].id).subscribe({
      next: (page) => this.putThread({ scope, messages: [...page.messages, ...thread.messages], more: page.more }),
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  send(scope: string, body: NewChatMessage, then?: (m: ChatMessage) => void): void {
    this.run(this.api.post(this.project(), scope, body), scope, (m) => {
      this.markSeen(scope, m.id);
      then?.(m);
    });
  }

  /** Runs a write for a chat; the failure shows in the panel, the success arrives as a `chat-changed` signal too. */
  run<T>(call: Observable<T>, scope: string | null, then?: (value: T) => void): void {
    call.subscribe({
      next: (v) => {
        this.error.set(null);
        then?.(v);
        this.changed$.next(scope);
      },
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  // ---------------------------------------------------------------------------------------------- viewer conveniences

  setView(view: ChatView): void {
    this.savePrefs({ ...this.prefs(), view });
  }

  setWidth(width: number): void {
    this.savePrefs({ ...this.prefs(), width: Math.max(340, Math.min(900, Math.round(width))) });
  }

  setSide(side: 'right' | 'left'): void {
    if (side !== this.prefs().side) this.savePrefs({ ...this.prefs(), side });
  }

  toggleSlim(): void {
    this.savePrefs({ ...this.prefs(), slim: !this.prefs().slim });
  }

  setMute(scope: string, mute: ChatMute): void {
    this.savePrefs({ ...this.prefs(), mute: { ...this.prefs().mute, [`${this.project()}/${scope}`]: mute } });
  }

  setNotify(on: boolean): void {
    this.savePrefs({ ...this.prefs(), notify: on });
  }

  /** The newest message the user has seen in a chat - the unread line and the bar's count start after it. */
  markSeen(scope: string, id: number): void {
    const key = `${this.project()}/${scope}`;
    if ((this.seen()[key] ?? 0) >= id) return;
    const next = { ...this.seen(), [key]: id };
    this.seen.set(next);
    writeJson(SEEN, next);
  }

  /** When this viewer last looked at each chat (epoch ms) - the digest starts there (FR-023). */
  private looked = readJson<Record<string, number>>(LOOKED, {});

  lookedAt(scope: string): number | null {
    return this.looked[`${this.project()}/${scope}`] ?? null;
  }

  markLooked(scope: string, at = Date.now()): void {
    this.looked = { ...this.looked, [`${this.project()}/${scope}`]: at };
    writeJson(LOOKED, this.looked);
  }

  lastSeen(scope: string): number {
    return this.seen()[`${this.project()}/${scope}`] ?? 0;
  }

  draftKey(scope: string): string {
    return `chat:${this.project()}/${scope}`;
  }

  draftChanged(): void {
    this.draftsVersion.update((v) => v + 1);
  }

  private hasDraft(key: string): boolean {
    try { return !!localStorage.getItem(DRAFT + key); } catch { return false; }
  }

  private unreadIn(scope: string, lastSeen: number): number {
    const t = this.threads().get(scope);
    return t ? unreadOf(t.messages, lastSeen).count : 1;
  }

  private savePrefs(p: Prefs): void {
    this.prefs.set(p);
    writeJson(PREFS, p);
  }

  // ------------------------------------------------------------------------------------------------------------ loads

  private reload(scopes: readonly (string | null)[]): void {
    if (!scopes.length) return;
    this.loadSummaries();
    const loaded = this.threads();
    const all = scopes.includes(null);
    for (const scope of loaded.keys()) {
      if (all || scopes.includes(scope) || (scope === PROJECT_SCOPE)) this.loadPage(scope);
    }
  }

  private loadSummaries(): void {
    const project = this.project();
    this.api.summaries(project).subscribe({
      next: (rows) => {
        if (project !== this.project()) return;
        this.summaries.set(rows);
        if (rows.some((r) => r.kind === 'cycle' && !this.cycleNames().has(r.scope))) this.loadCycles();
      },
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  private loadCycles(): void {
    this.cyclesApi.list().subscribe({ next: (c) => this.cycles.set(c), error: () => undefined });
    this.boardsApi.boards(null).subscribe({ next: (b) => this.boardNames.set(new Map(b.map((x) => [x.board.id, x.board.name]))), error: () => undefined });
  }

  /** The newest page; older pages the user scrolled to stay loaded below it. */
  private loadPage(scope: string): void {
    const project = this.project();
    this.api.messages(project, scope).subscribe({
      next: (page) => {
        if (project !== this.project()) return;
        const had = this.threads().get(scope);
        const first = page.messages[0]?.id;
        const older = had && first != null ? had.messages.filter((m) => m.id < first) : [];
        this.putThread({ scope, messages: [...older, ...page.messages], more: older.length ? had!.more : page.more });
      },
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  private putThread(thread: ChatThread): void {
    const next = new Map(this.threads());
    next.set(thread.scope, thread);
    this.threads.set(next);
  }
}
