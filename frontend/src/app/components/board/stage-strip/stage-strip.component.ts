import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { debounceTime, filter } from 'rxjs';
import { BoardStage, stageCommand } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { TeamApiService } from '../../../core/team/team-api.service';
import { SyncResult } from '../../../core/team/team.models';

/** The seven stages of a task (specs/030 FR-013); the first, Board, is done once the board exists. */
export const STAGES = [
  { key: 'BOARD', label: 'Board', hint: 'Made in the UI - nothing runs by itself' },
  { key: 'DEFINE', label: 'Define', hint: 'Brief, spec, steps, data and the cards: /alfred-setup' },
  { key: 'TRIAGE', label: 'Triage', hint: 'Yours, another team\'s, or close - with a look at the code: /alfred-triage' },
  { key: 'CODE', label: 'Code', hint: 'You write it' },
  { key: 'VERIFY', label: 'Verify', hint: 'The code moves cards: /alfred-verify' },
  { key: 'TEST', label: 'Test', hint: 'Record, then the calls tick steps and re-test cards: /alfred-listen' },
  { key: 'CLOSE', label: 'Close', hint: 'The report and one update for the main item: /alfred-report' },
] as const;

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
 * The stage strip under the board header (specs/030 D7): the seven stages with the current one marked and its exact
 * command (Copy); "Not defined yet" with the setup command and "Ask Claude in chat" (only while someone answers the
 * board's chat); and "↻ Refresh from Azure" for a board with a main item - the copies updated with no Claude run, the
 * result in one line, a banner when the main moved. Re-read on the board's socket signals, never on a timer.
 */
@Component({
  selector: 'app-stage-strip',
  standalone: true,
  styles: [`
    .ss { display: flex; flex-wrap: wrap; gap: .3rem; align-items: center; margin: .45rem 0 .2rem; font-size: .8rem; }
    .bs { padding: .1rem .5rem; border: 1px solid var(--border); border-radius: 999px; color: var(--text-dim); white-space: nowrap; }
    .bs.done { opacity: .7; }
    .bs.done::before { content: '✓ '; }
    .bs.on { color: var(--text); border-color: var(--accent-blue, #5b8def); background: var(--card-inner); font-weight: 600; }
    .ss-next { flex: 1 1 16rem; color: var(--text-dim); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ss-box { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; margin: .2rem 0 .4rem; padding: .45rem .7rem;
      border: 1px dashed var(--border-strong); border-radius: 8px; font-size: .84rem; }
    .ss-box code { padding: 0 .3rem; border-radius: 4px; background: var(--card-inner); }
    .ss-warn { border-style: solid; border-color: var(--amber); }
    .ss-err { color: var(--red); }
    .ss-dim { color: var(--text-dim); }
  `],
  template: `
    @if (stage(); as st) {
      <div class="ss" role="list" aria-label="Task stages">
        @for (s of stages; track s.key; let i = $index) {
          <span role="listitem" class="bs" [class.done]="i < at()" [class.on]="i === at()" [title]="s.hint">{{ i + 1 }} {{ s.label }}</span>
        }
        <span class="ss-next" [title]="st.next">Next: {{ st.next }}</span>
        @if (command(); as cmd) {
          <button type="button" class="board-copy" [title]="'Copy ' + cmd + ' - paste it into Claude Code'" (click)="copy(cmd)">{{ copied() === cmd ? '✓ Copied' : '⧉ Copy' }}</button>
        }
        @if (linkedItem() && editable()) {
          <button type="button" class="action-btn" [disabled]="refreshing()" title="Read the main item's tree live and update the copies - no Claude run"
                  (click)="refresh()">{{ refreshing() ? 'Refreshing…' : '↻ Refresh from Azure' }}</button>
        }
      </div>
      @if (st.stage === 'DEFINE' && !st.counts.brief) {
        <div class="ss-box" role="note">
          <b>Not defined yet:</b> no brief, spec or cards. Run it in your terminal: <code>{{ setupCmd() }}</code>
          <button type="button" class="board-copy" (click)="copy(setupCmd())">{{ copied() === setupCmd() ? '✓ Copied' : '⧉ Copy' }}</button>
          <span class="ss-dim">or</span>
          <button type="button" class="action-btn" [disabled]="!answered() || !editable() || asking()" [title]="askTitle()" (click)="ask()">Ask Claude in chat</button>
          @if (asked()) { <span class="ss-dim">{{ asked() }}</span> }
        </div>
      }
    }
    @if (result(); as r) {
      <div class="ss-box" role="status">
        <span>Azure: {{ line() }}</span>
        @if (r.newItems?.length || r.changedItems?.length || r.matches) {
          <span class="ss-dim">Run <code>{{ setupCmd() }}</code> to bring them onto the board</span>
          <button type="button" class="board-copy" (click)="copy(setupCmd())">{{ copied() === setupCmd() ? '✓ Copied' : '⧉ Copy' }}</button>
        }
        <button type="button" class="board-link" (click)="result.set(null)">✕</button>
      </div>
      @if (r.mainState; as m) {
        <div class="ss-box ss-warn" role="alert">
          <b>AB#{{ m.item }}</b>
          @if (m.fromState !== m.toState) { <span>moved {{ m.fromState }} → {{ m.toState }}@if (m.category) { ({{ m.category }})}</span> }
          @if (m.fromIteration !== m.toIteration) { <span>· iteration {{ m.fromIteration || '-' }} → {{ m.toIteration || '-' }}</span> }
          @if (m.closed || m.fromIteration !== m.toIteration) {
            <span class="ss-dim">On the next setup run Claude proposes closing the open cards as Not in this flow and stopping listen. You decide.</span>
          }
        </div>
      }
    }
    @if (error()) { <div class="ss-err" role="alert">{{ error() }}</div> }`,
})
export class StageStripComponent {
  private readonly api = inject(BoardApiService);
  private readonly chatApi = inject(ChatApiService);
  private readonly team = inject(TeamApiService);

  readonly project = input('');
  readonly boardId = input.required<string>();
  /** The board's main item ("<conn>/<id>"), when it has one: Refresh from Azure shows only then. */
  readonly linkedItem = input<string | null>(null);
  readonly editable = input(true);

  readonly stages = STAGES;
  readonly stage = signal<BoardStage | null>(null);
  readonly at = computed(() => {
    const st = this.stage();
    return st ? this.stages.findIndex((s) => s.key === st.stage) : 0;
  });
  readonly command = computed(() => (this.stage() ? stageCommand(this.stage()!.next) : null));
  readonly setupCmd = computed(() => `/alfred-setup ${this.stage()?.ref ?? ''}`.trimEnd());
  readonly copied = signal<string | null>(null);
  /** Someone answers this board's chat now: a terminal holding it, or the project's live runner. */
  readonly answered = signal(false);
  readonly askTitle = computed(() => (this.answered() ? `Posts ${this.setupCmd()} to the board chat - the runner answering it drafts the task`
    : `Start /alfred-live ${this.stage()?.ref ?? ''} first - nobody answers the board chat now`));
  readonly asking = signal(false);
  readonly asked = signal<string | null>(null);
  readonly refreshing = signal(false);
  readonly result = signal<SyncResult | null>(null);
  readonly line = computed(() => (this.result() ? refreshLine(this.result()!) : ''));
  readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      const id = this.boardId();
      untracked(() => {
        this.result.set(null);
        this.asked.set(null);
        this.load(id);
      });
    });
    const sub = inject(BoardSocketService).events$.pipe(
      filter((e) => (e.type === 'board-changed' && (!e.project || e.project === this.project()))
        || ((e.type === 'live-runner' || e.type === 'cycle-chat') && e.project === this.project())),
      debounceTime(400),
    ).subscribe(() => this.load(this.boardId()));
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }

  load(id: string): void {
    this.api.stage(id).subscribe({
      next: (st) => {
        if (this.boardId() !== id) return;
        this.stage.set(st);
        if (st.stage === 'DEFINE' && !st.counts.brief) this.readAnswerer(id);
      },
      error: () => this.stage.set(null),
    });
  }

  private readAnswerer(boardId: string): void {
    const project = this.project();
    this.chatApi.summaries(project).subscribe({ next: (all) => {
      const s = all.find((x) => x.scope === boardId);
      if (s?.terminal?.open || s?.claudeOn) this.answered.set(true);
    }, error: () => undefined });
    this.api.liveRunner(project).subscribe({ next: (r) => { if (r) this.answered.set(true); }, error: () => undefined });
  }

  copy(text: string): void {
    void navigator.clipboard?.writeText(text).then(() => {
      this.copied.set(text);
      setTimeout(() => this.copied.set(null), 1500);
    }, () => undefined);
  }

  /** "Ask Claude in chat": the setup command as the user's own message in the board's chat. */
  ask(): void {
    this.asking.set(true);
    this.chatApi.post(this.project(), this.boardId(), { text: this.setupCmd() }).subscribe({
      next: () => { this.asking.set(false); this.asked.set('Sent to the board chat - the draft comes back there'); },
      error: (e: HttpErrorResponse) => { this.asking.set(false); this.asked.set(e?.error?.message ?? 'Not sent'); },
    });
  }

  refresh(): void {
    this.refreshing.set(true);
    this.error.set(null);
    this.team.refresh(this.boardId()).subscribe({
      next: (r) => { this.refreshing.set(false); this.result.set(r); this.load(this.boardId()); },
      error: (e: HttpErrorResponse) => {
        this.refreshing.set(false);
        this.error.set(e?.error?.error === 'TOKEN_MISSING' ? 'Enter your token in the Team tab first' : (e?.error?.message ?? 'The refresh failed'));
      },
    });
  }
}
