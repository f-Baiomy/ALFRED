import { Component, DestroyRef, ElementRef, HostListener, Injector, computed, effect, inject, input, output, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { CardSummary, SkillRun } from '../../../core/models/board.models';
import { AppConfigService } from '../../../core/services/app-config.service';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardStateService } from '../../../core/state/board-state.service';
import { CHAT_BUSY_AFTER_MS, RUN_DONE_SHOWN_MS, SkillRunsStateService, waiting } from '../../../core/state/skill-runs-state.service';
import { copyToClipboard } from '../../../shared/utils/clipboard';
import { failureHint, runDuration, shellLine, skillOf, skillPrompt, startSteps, usualText } from '../../../shared/utils/skill-prompt';

type View = 'idle' | 'copy' | 'start' | 'sending' | 'sent' | 'busy' | 'closed' | 'running' | 'done' | 'failed' | 'stopped';

/**
 * A /alfred-* command on the board as a run button with a copy button beside it (docs/board.md "Run from the board").
 * A cycle belongs to the Claude Code chat that runs /alfred-live or /alfred-listen for it: ▶ sends the request into
 * that chat, which runs it with its own context, and the button follows it - sent, waiting while the chat is busy (or
 * seems closed), running in the chat, done or failed. With no chat for the cycle ▶ shows how to start one; a command
 * without a cycle, or a read-only board, copies. ⧉ always copies the same prompt. ▾ edits the prompt or adds a note,
 * and copies in other forms; Shift+click edits.
 */
@Component({
  selector: 'app-run-skill',
  standalone: true,
  template: `
    <span [class]="'run-skill run-' + view()">
      <button type="button" class="run-go" [title]="title()" (click)="go($event)">
        <span class="run-ico">@if (view() === 'sending') { <span class="run-spin"></span> } @else if (view() === 'copy' && copied() && copied() !== 'failed') { ✓ } @else { {{ icon() }} }</span>
        <span class="run-cmd">{{ command() }}</span>
        @if (copyOnly() && copied()) { <span class="run-tail" [class.run-copied]="copied() !== 'failed'">{{ copied() === 'failed' ? 'select it and press Ctrl+C' : 'copied' }}</span> } @else { @if (tail(); as t) { <span class="run-tail">{{ t }}</span> } }
      </button>
      @if (!copyOnly()) {
        <button type="button" class="run-cp" [title]="'Copy the full prompt - paste it into Claude Code or another agent'" (click)="copyPrompt()">
          {{ copied() === 'prompt' ? '✓' : '⧉' }}</button>
      }
      @if (canRun()) {
        <button type="button" class="run-caret" title="More: edit the prompt, a note, copy as…" [attr.aria-expanded]="menu()"
                (click)="$event.stopPropagation(); toggleMenu($event)">▾</button>
      }
      @if (view() === 'sent' || view() === 'busy' || view() === 'closed') {
        <button type="button" class="run-stop" title="Cancel - the chat has not taken it yet" (click)="stop()">✕</button>
      }
      @if (menu()) {
        <div class="run-menu" role="menu" [style.top.px]="menuAt().top" [style.left.px]="menuAt().left" (click)="$event.stopPropagation()">
          <button type="button" class="run-mi" (click)="openEditor(false)">✎ Edit the prompt, then run…</button>
          <button type="button" class="run-mi" (click)="openEditor(true)">✚ Add a note for Claude…</button>
          <button type="button" class="run-mi" (click)="state.setNotify(!state.notify())">🔔 Tell me when it ends (tab in the background)
            <span class="run-sw" [class.on]="state.notify()">{{ state.notify() ? 'on' : 'off' }}</span></button>
          <div class="run-sep"></div>
          <button type="button" class="run-mi" (click)="copyText(command(), 'cmd')">⧉ Copy the command only <code>{{ command() }}</code></button>
          <button type="button" class="run-mi" (click)="copyText(shell(), 'shell')">⧉ Copy as a shell line <code>claude -p "…"</code></button>
        </div>
      }
    </span>
    @if (message(); as m) {
      <span class="run-msg" [class.run-msg-err]="m.tone === 'err'" [class.run-msg-ok]="m.tone === 'ok'">{{ m.text }}
        @if (m.result; as r) { · <button type="button" class="board-link" (click)="openResult(r)">open {{ r }}</button> }
        @if (m.how) { · <button type="button" class="board-link" (click)="starting.set(true)">how</button> }
        @if (m.tone === 'err' && !m.how) {
          · <button type="button" class="board-link" (click)="copyPrompt()">{{ copied() === 'prompt' ? 'copied' : 'copy the prompt' }}</button>
          @if (canRun()) { · <button type="button" class="board-link" (click)="send(prompt(), lastNote)">retry</button> }
        }
        <button type="button" class="board-link run-dismiss" title="Hide" (click)="dismiss()">✕</button>
      </span>
    }
    @if (starting()) {
      <div class="run-dialog-bg" (click)="starting.set(false)">
        <div class="run-dialog run-start-steps" role="dialog" aria-label="Start a chat for this cycle" (click)="$event.stopPropagation()">
          <div class="run-dialog-head">No chat is handling {{ cycleLabel() }} yet</div>
          <div class="run-dim">Board requests run in the Claude Code chat that listens on this cycle - with its context, model and account. Start one:</div>
          <ol class="run-steps">
            <li>Open Claude Code in the app's repo
              <button type="button" class="run-cmdline" (click)="copyText(steps().cd, 'cd')">{{ steps().cd }} <b>{{ copied() === 'cd' ? '✓' : '⧉' }}</b></button></li>
            <li>Answer on the board for this cycle
              <button type="button" class="run-cmdline" (click)="copyText(steps().live, 'live')">{{ steps().live }} <b>{{ copied() === 'live' ? '✓' : '⧉' }}</b></button></li>
            <li>While you test (optional, same chat)
              <button type="button" class="run-cmdline" (click)="copyText(steps().listen, 'listen')">{{ steps().listen }} <b>{{ copied() === 'listen' ? '✓' : '⧉' }}</b></button></li>
            <li>Press ▶ again - it runs in that chat.</li>
          </ol>
          <div class="run-dim">Or paste the request into any Claude chat now:
            <button type="button" class="board-link" (click)="copyPrompt()">{{ copied() === 'prompt' ? '✓ copied' : '⧉ copy the prompt' }}</button></div>
          <div class="run-dialog-row run-dialog-acts">
            <button type="button" class="board-copy" (click)="starting.set(false)">Close</button>
          </div>
        </div>
      </div>
    }
    @if (editing()) {
      <div class="run-dialog-bg" (click)="editing.set(false)">
        <div class="run-dialog" role="dialog" aria-label="Edit the prompt" (click)="$event.stopPropagation()">
          <div class="run-dialog-head">▶ Run <code>{{ command() }}</code> in the cycle's chat{{ chat() ? ' (' + chat()!.host + ')' : '' }}</div>
          <label class="run-dim">The prompt - exactly what is sent:
            <textarea #promptBox class="run-text" rows="6" [value]="draft()" (input)="draft.set(promptBox.value)"></textarea></label>
          <label class="run-dim">A note for Claude (kept with the run):
            <input #noteBox class="run-input" [value]="note()" (input)="note.set(noteBox.value)" placeholder="e.g. only the OrganizationModel mapping - do not touch the DAO"
                   (keydown.enter)="runEdited()" /></label>
          <div class="run-dialog-row run-dialog-acts">
            <button type="button" class="board-copy" (click)="copyText(draft(), 'draft')">{{ copied() === 'draft' ? '✓ copied' : '⧉ Copy' }}</button>
            <button type="button" class="board-copy" (click)="editing.set(false)">Cancel</button>
            <button type="button" class="board-copy run-primary" [disabled]="!canRun()" (click)="runEdited()">▶ Run</button>
          </div>
        </div>
      </div>
    }`,
})
export class RunSkillComponent {
  readonly state = inject(SkillRunsStateService);
  private readonly config = inject(AppConfigService);
  private readonly host$ = inject(ElementRef<HTMLElement>);
  /** Read only for "open #N" of a card not on the board in view. */
  private readonly injector = inject(Injector);
  /** On the board: "open #36" opens the card in the drawer; elsewhere the parent hears it (opened). */
  private readonly board = inject(BoardStateService, { optional: true });

  readonly command = input.required<string>();
  readonly project = input('');
  readonly cycleId = input<string | null>(null);
  readonly cycleName = input<string | null>(null);
  readonly card = input<Pick<CardSummary, 'number' | 'kind' | 'status' | 'title' | 'waiting'> | null>(null);
  readonly lastUserWord = input<string | null>(null);
  /** May this viewer change the board (the tunnel and other read-only views copy only). */
  readonly editable = input(true);
  /** A command meant for another session (resume): never run from here. */
  readonly copyOnly = input(false);
  /** A card the run wrote ("open #36"). */
  readonly opened = output<number>();

  readonly menu = signal(false);
  /** Where the menu opens: fixed to the viewport at the ▾, so a card's overflow never clips it. */
  readonly menuAt = signal({ top: 0, left: 0 });
  readonly editing = signal(false);
  /** The "start a chat for this cycle" steps. */
  readonly starting = signal(false);
  readonly draft = signal('');
  readonly note = signal('');
  readonly sending = signal(false);
  readonly copied = signal<string | null>(null);
  readonly refusal = signal<string | null>(null);
  private readonly dismissed = signal<string | null>(null);
  private readonly now = signal(Date.now());
  lastNote: string | null = null;

  readonly prompt = computed(() => skillPrompt({ command: this.command(), alfredUrl: this.config.backendUrl, project: this.project(),
    cycleId: this.cycleId(), cycleName: this.cycleName(), card: this.card(), lastUserWord: this.lastUserWord() }));
  readonly shell = computed(() => shellLine(this.prompt()));
  /** The chat that handles this cycle - every ▶ goes into it. */
  readonly chat = computed(() => (this.state.cycles(), this.state.chat(this.cycleId())));
  /** A cycle's command on an editable board: it runs in the cycle's chat, or says how to start one. */
  readonly forChat = computed(() => !this.copyOnly() && this.editable() && !!this.cycleId());
  readonly canRun = computed(() => this.forChat() && !!this.chat());
  readonly run = computed<SkillRun | null>(() => (this.state.projects(), this.state.latest(this.project(), this.card()?.number ?? null, this.command())));
  readonly usual = computed(() => (this.state.projects(), this.state.usual(this.project(), skillOf(this.command()))));
  readonly cycleLabel = computed(() => (this.cycleName() ? `"${this.cycleName()}"` : 'this cycle'));
  readonly steps = computed(() => startSteps(this.cycleId() ?? '<cycle>', (this.state.cycles(), this.state.lastCwd(this.cycleId()))));

  readonly view = computed<View>(() => {
    // a command for another session only copies: no run of this board ever takes it over
    if (this.copyOnly()) return 'copy';
    if (this.sending()) return 'sending';
    const r = this.run();
    const now = this.now();
    if (r && r.id !== this.dismissed()) {
      if (waiting(r)) {
        const chat = this.chat();
        if (!chat || !chat.chatAlive) return 'closed';
        return now - Date.parse(r.createdAt) < CHAT_BUSY_AFTER_MS ? 'sent' : 'busy';
      }
      if (r.state === 'RUNNING') return 'running';
      const ended = Date.parse(r.endedAt ?? r.updatedAt);
      if (r.state === 'FAILED') return 'failed';
      if (now - ended < RUN_DONE_SHOWN_MS) return r.state === 'DONE' ? 'done' : 'stopped';
    }
    return this.canRun() ? 'idle' : this.forChat() ? 'start' : 'copy';
  });

  readonly icon = computed(() => ({ idle: '▶', copy: '⧉', start: '▶', sending: '', sent: '◌', busy: '⏳', closed: '⏳', running: '✦', done: '✓', failed: '✕',
    stopped: '■' })[this.view()]);

  readonly tail = computed(() => {
    const r = this.run();
    this.now();
    switch (this.view()) {
      case 'sending': return 'sending…';
      case 'sent': return 'sent to the chat';
      case 'busy': {
        const place = r ? this.state.place(r) : 0;
        return `waiting - the chat is busy${place > 1 ? ` · ${ordinal(place)}` : ''}`;
      }
      case 'closed': return this.chat() ? 'waiting - the chat seems closed' : 'waiting - no chat handles the cycle';
      case 'running': {
        if (!r) return null;
        const usual = usualText(this.usual());
        const took = Date.now() - Date.parse(r.takenAt ?? r.createdAt);
        return `running in the chat · ${runDuration(r)}${usual && took > (this.usual() ?? 0) ? ` · usually ${usual}` : ''}`;
      }
      case 'done': return r ? `done · ${runDuration(r)}` : 'done';
      case 'failed': return 'failed';
      case 'stopped': return r?.state === 'CANCELLED' ? 'cancelled' : 'stopped';
      default: return null;
    }
  });

  readonly title = computed(() => {
    if (this.copyOnly()) return `Copy ${this.command()} - paste it into another Claude Code session`;
    if (!this.editable()) return 'Copies the prompt - this view of the board is read-only';
    if (!this.cycleId()) return 'Copies the prompt - only a cycle\'s commands run from the board, in the chat that handles the cycle';
    const chat = this.chat();
    if (!chat) return 'No chat handles this cycle yet - click for how to start one';
    const usual = usualText(this.usual());
    return `Run in the cycle's chat (${chat.host}, since ${new Date(chat.since).toTimeString().slice(0, 5)})${usual ? ` - usually ${usual}` : ''} · Shift+click: edit first`;
  });

  readonly message = computed<{ text: string; tone: 'ok' | 'err' | 'dim'; result?: string; how?: boolean } | null>(() => {
    const refusal = this.refusal();
    if (refusal) return { text: refusal, tone: 'err' };
    const r = this.run();
    if (!r || r.id === this.dismissed()) return null;
    switch (this.view()) {
      case 'done': return { text: `✓ ${r.outcome ?? 'done'}`, tone: 'ok', result: firstCard(r.result) ?? undefined };
      case 'failed': return { text: `✕ ${failureHint(r)}`, tone: 'err', result: firstCard(r.result) ?? undefined };
      case 'closed': return this.chat()
        ? { text: 'The cycle\'s chat seems closed - open it again, or stop it there (/alfred-live stop) and start a new one; this waits for it', tone: 'err', how: true }
        : { text: 'No chat handles this cycle now - start one and this runs in it', tone: 'err', how: true };
      default: return null;
    }
  });

  constructor() {
    effect(() => {
      this.state.watch(this.project());
      this.state.watchCycle(this.project(), this.cycleId());
    }, { allowSignalWrites: true });
    // A second's tick while a run is shown, for its time and to fold a finished one - not a poll: nothing is fetched.
    let timer: ReturnType<typeof setInterval> | null = null;
    effect(() => {
      const live = ['sent', 'busy', 'closed', 'running', 'done', 'stopped', 'sending'].includes(this.view());
      if (live && !timer) timer = setInterval(() => this.now.set(Date.now()), 1000);
      if (!live && timer) { clearInterval(timer); timer = null; }
    }, { allowSignalWrites: true });
    inject(DestroyRef).onDestroy(() => { if (timer) clearInterval(timer); });
  }

  toggleMenu(event: MouseEvent): void {
    if (this.menu()) { this.menu.set(false); return; }
    const r = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const width = Math.min(336, window.innerWidth * 0.86);
    const left = Math.max(8, Math.min(r.left - width + r.width, window.innerWidth - width - 8));
    const below = r.bottom + 4;
    this.menuAt.set({ top: below + 180 > window.innerHeight ? Math.max(8, r.top - 184) : below, left });
    this.menu.set(true);
  }

  @HostListener('document:wheel')
  @HostListener('window:scroll')
  @HostListener('window:resize')
  @HostListener('document:click')
  closeMenu(): void {
    if (this.menu()) this.menu.set(false);
  }

  @HostListener('document:keydown.escape')
  escape(): void {
    this.menu.set(false);
    this.editing.set(false);
    this.starting.set(false);
  }

  /** ▶ (or ⧉ when it cannot run, or the start steps with no chat for the cycle); Shift+click opens the editor. Also the drawer's R key. */
  go(event?: MouseEvent): void {
    if (event?.shiftKey && this.canRun()) { this.openEditor(false); return; }
    const v = this.view();
    if (v === 'sent' || v === 'busy' || v === 'closed' || v === 'running' || v === 'sending') return;
    if (this.canRun()) { this.send(this.prompt(), null); return; }
    if (this.forChat()) { this.starting.set(true); return; }
    // a command for another session is pasted as typed there: the command, not the prompt
    if (this.copyOnly()) { this.copyText(this.command(), 'cmd'); return; }
    this.copyPrompt();
  }

  send(prompt: string, note: string | null): void {
    this.refusal.set(null);
    this.dismissed.set(null);
    this.sending.set(true);
    this.lastNote = note;
    this.state.run({ project: this.project(), cycleId: this.cycleId(), cardNumber: this.card()?.number ?? null, command: this.command(), prompt,
      note: note?.trim() || null }).subscribe({
      next: () => this.sending.set(false),
      error: (e: HttpErrorResponse) => {
        this.sending.set(false);
        if (e?.status === 404) { this.starting.set(true); return; } // the chat stopped meanwhile
        this.refusal.set(`✕ ${e?.error?.message ?? e?.message ?? 'not sent'}`);
      },
    });
  }

  openEditor(focusNote: boolean): void {
    this.menu.set(false);
    this.draft.set(this.prompt());
    this.editing.set(true);
    setTimeout(() => (this.host$.nativeElement.querySelector(focusNote ? '.run-input' : '.run-text') as HTMLElement | null)?.focus(), 0);
  }

  runEdited(): void {
    if (!this.canRun()) return;
    this.editing.set(false);
    this.send(this.draft(), this.note());
    this.note.set('');
  }

  stop(): void {
    const r = this.run();
    if (r) this.state.stop(r);
  }

  copyPrompt(): void {
    this.copyText(this.prompt(), 'prompt');
  }

  copyText(text: string, what: string): void {
    void copyToClipboard(text).then(() => {
      this.copied.set(what);
      setTimeout(() => this.copied.set(null), 1500);
    }, () => {
      // the browser refused the clipboard: say so and select the command, so Ctrl+C takes it
      this.copied.set('failed');
      const cmd = (this.host$.nativeElement as HTMLElement).querySelector('.run-cmd');
      const sel = typeof window !== 'undefined' ? window.getSelection() : null;
      if (cmd && sel) { const r = document.createRange(); r.selectNodeContents(cmd); sel.removeAllRanges(); sel.addRange(r); }
      setTimeout(() => this.copied.set(null), 4000);
    });
    if (what === 'cmd' || what === 'shell') this.menu.set(false);
  }

  dismiss(): void {
    this.refusal.set(null);
    this.dismissed.set(this.run()?.id ?? null);
  }

  openResult(r: string): void {
    const n = Number(r.replace('#', ''));
    if (!n) return;
    const board = this.board;
    if (!board) { this.opened.emit(n); return; }
    const here = board.cards().find((c) => c.number === n && c.project === this.project());
    if (here) { board.open(here.id); return; }
    this.injector.get(BoardApiService).cardByNumber(this.project(), n).subscribe({ next: (c) => board.open(c.id), error: () => this.opened.emit(n) });
  }
}

function ordinal(n: number): string {
  return n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
}

/** "#36 #37" -> "#36" */
function firstCard(result: string | null): string | null {
  return result?.match(/#\d+/)?.[0] ?? null;
}
