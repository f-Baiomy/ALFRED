import { Component, HostListener, computed, effect, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { PROJECT_SCOPE } from '../../../core/models/chat.models';
import { BarRow, ChatStateService } from '../../../core/state/chat-state.service';
import { barTime, initials, needsYouLine } from '../../../shared/utils/chat-queue';
import { barSections } from '../../../shared/utils/chat-bar';

/**
 * The chats (specs/022 FR-017, FR-039) as a pill floating bottom-right: the unread count and the three chats that changed
 * last; a click opens the list above it - the project chat and every cycle chat, with who answers (a green dot when
 * Claude is on), the last line, unread, typing, drafts, mute, and a "Needs you" section. Chats folded with – wait as
 * tabs beside it. Dragged across the middle, the pill moves to the other side and stays there. Ctrl+K finds a chat.
 */
@Component({
  selector: 'app-chat-bar',
  standalone: true,
  imports: [NgTemplateOutlet],
  template: `
    @if (state.listOpen()) {
      <div class="chat-list" role="dialog" aria-label="Board chats">
        <div class="chat-list-head"><b>Chats</b>
          <input type="search" class="chat-list-find" placeholder="Find a chat (Ctrl+K)" [value]="find()" (input)="find.set($any($event.target).value)" />
        </div>
        <div class="bar-list">
          @if (needs().length) {
            <div class="bar-sec need">Needs you</div>
            @for (r of needs(); track r.scope) { <ng-container *ngTemplateOutlet="row; context: { $implicit: r }" /> }
          }
          @for (sec of sections(); track sec.label) {
            @if (sec.rows.length) {
              <div class="bar-sec">{{ sec.label }}</div>
              @for (r of sec.rows; track r.scope) { <ng-container *ngTemplateOutlet="row; context: { $implicit: r }" /> }
            }
          }
          @if (!state.rows().length) { <div class="board-dim" style="padding:.5rem">No chats yet.</div> }
        </div>
        <div class="bar-foot">{{ onCount() }} with Claude on · drag the pill to move it</div>
      </div>
    }
    <div class="chat-pill" [class.open]="state.listOpen()" role="button" tabindex="0" aria-label="Board chats"
         (mousedown)="dragStart($event)" (keydown.enter)="toggle()">
      <span class="pill-ic">💬@if (state.totalUnread()) {<em>{{ state.totalUnread() > 99 ? '99+' : state.totalUnread() }}</em>}</span>
      <b class="pill-label">Chats</b>
      <span class="pill-avs">
        @for (r of recent(); track r.scope) {
          <button type="button" class="bar-av" [class.project]="r.scope === project" [class.cycle]="r.scope !== project" [class.need]="needs().includes(r)"
                  [class.typing]="r.typing" [title]="r.label + (r.unread ? ' · ' + r.unread + ' new' : '')" (mousedown)="$event.stopPropagation()" (click)="pick(r.scope)">
            {{ r.scope === project ? 'PR' : av(r.label) }}<span class="bar-st" [class.on]="r.claudeOn"></span></button>
        }
      </span>
      <span class="pill-more">{{ state.listOpen() ? '▾' : '⋯' }}</span>
    </div>
    @for (t of tabRows(); track t.scope) {
      <div class="chat-tab" [title]="'Open ' + t.label">
        <button type="button" class="chat-tab-open" (click)="state.openChat(t.scope)">
          <span class="bar-av" [class.project]="t.scope === project" [class.cycle]="t.scope !== project">{{ t.scope === project ? 'PR' : av(t.label) }}</span>
          <b>{{ t.label }}</b>@if (t.unread) {<em class="bar-ub">{{ t.unread }}</em>}</button>
        <button type="button" class="chat-tab-x" title="Close" (click)="state.closeTab(t.scope)">✕</button>
      </div>
    }

    <ng-template #row let-r>
      <button type="button" class="bar-item" [class.on]="state.openScope() === r.scope" [class.unread]="r.unread > 0"
              [title]="tip(r)" (click)="pick(r.scope)">
        <span class="bar-av" [class.project]="r.scope === project" [class.cycle]="r.scope !== project" [class.need]="needs().includes(r)">
          {{ r.scope === project ? 'PR' : av(r.label) }}<span class="bar-st" [class.on]="r.claudeOn"></span>
        </span>
        <span class="bar-txt">
          <span class="bar-name">{{ r.label }}@if (r.mute === 'none') { <span class="bar-mute" title="Muted">🔕</span> }</span>
          <span class="bar-time">{{ time(r.lastAt) }}</span>
          @if (r.typing) {
            <span class="bar-prev typing"><span class="bar-typing"><i></i><i></i><i></i></span>Claude is answering…</span>
          } @else if (r.draft) {
            <span class="bar-prev"><span class="bar-draft">Draft</span> - not sent</span>
          } @else {
            <span class="bar-prev">{{ r.lastAuthor === 'USER' ? 'You: ' : r.lastAuthor === 'CLAUDE' ? 'Claude: ' : '' }}{{ r.lastPreview || 'No messages yet' }}</span>
          }
          @if (needLine(r); as n) { <span class="bar-need">● {{ n }}</span> }
          @if (r.waiting) { <span class="bar-wait">{{ r.waiting }} waiting{{ r.claudeOn ? '' : ' - Claude is off' }}</span> }
        </span>
        @if (r.unread && r.mute !== 'none') { <span class="bar-ub">{{ r.unread }}</span> }
      </button>
    </ng-template>

    @if (switcher()) {
      <div class="dialog-backdrop" (click)="switcher.set(false)">
        <div class="dialog-card" (click)="$event.stopPropagation()" style="max-width:460px">
          <input class="qs-input" autofocus placeholder="Jump to a chat…" [value]="find()" (input)="find.set($any($event.target).value)"
                 (keydown.enter)="pickFirst()" (keydown.escape)="switcher.set(false)" />
          <div class="qs-list">
            @for (r of filtered(); track r.scope; let i = $index) {
              <button type="button" class="bar-item" [class.on]="i === 0" (click)="pick(r.scope); switcher.set(false)">
                <span class="bar-av" [class.project]="r.scope === project" [class.cycle]="r.scope !== project">{{ r.scope === project ? 'PR' : av(r.label) }}</span>
                <span class="bar-txt"><span class="bar-name">{{ r.label }}</span><span class="bar-time">{{ r.unread ? r.unread + ' new' : '' }}</span></span>
              </button>
            }
          </div>
        </div>
      </div>
    }`,
})
export class ChatBarComponent {
  readonly state = inject(ChatStateService);
  readonly project = PROJECT_SCOPE;
  readonly find = signal('');
  readonly switcher = signal(false);

  private readonly found = computed(() => barSections(this.state.rows(), this.find()));
  readonly filtered = computed(() => [...this.found().needs, ...this.found().sections.flatMap((s) => s.rows)]);
  readonly needs = computed(() => this.found().needs);
  readonly sections = computed(() => this.found().sections);
  readonly onCount = computed(() => this.state.rows().filter((r) => r.claudeOn).length);

  constructor() {
    // The tab's title carries the unread count while the window is in the background.
    effect(() => {
      const n = this.state.totalUnread();
      const base = document.title.replace(/^\(\d+\) /, '');
      document.title = n ? `(${n}) ${base}` : base;
    });
  }

  /** The three chats that changed last, those needing the user first. */
  readonly recent = computed(() => {
    const rows = [...this.state.rows()];
    const needs = new Set(this.needs().map((r) => r.scope));
    return rows.sort((a, b) => Number(needs.has(b.scope)) - Number(needs.has(a.scope)) || (b.lastAt ?? '').localeCompare(a.lastAt ?? '')).slice(0, 3);
  });
  readonly tabRows = computed(() => this.state.tabs().map((s) => this.state.rows().find((r) => r.scope === s)).filter((r): r is BarRow => !!r));

  pick(scope: string): void {
    this.state.openChat(scope);
  }

  toggle(): void {
    this.find.set('');
    this.state.listOpen.set(!this.state.listOpen());
  }

  /** A click opens the list; a drag past the middle of the window moves the pill to that side. */
  dragStart(e: MouseEvent): void {
    if (e.button !== 0) return;
    const x0 = e.clientX;
    let moved = false;
    const move = (ev: MouseEvent) => { if (Math.abs(ev.clientX - x0) > 6) moved = true; };
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (!moved) { this.toggle(); return; }
      this.state.setSide(ev.clientX < window.innerWidth / 2 ? 'left' : 'right');
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  pickFirst(): void {
    const first = this.filtered()[0];
    if (first) this.state.openChat(first.scope);
    this.switcher.set(false);
  }

  av(label: string): string {
    return initials(label);
  }

  time(iso: string | null): string {
    return barTime(iso);
  }

  needLine(r: BarRow): string {
    return needsYouLine(r.needsYou);
  }

  tip(r: BarRow): string {
    return `${r.label} - ${r.claudeOn ? 'Claude is on' : 'Claude is off (messages wait)'}${r.waiting ? ` · ${r.waiting} waiting` : ''}`;
  }

  /** A click anywhere else closes the list. */
  @HostListener('document:mousedown', ['$event'])
  outside(e: MouseEvent): void {
    if (this.state.listOpen() && !(e.target as Element | null)?.closest?.('.chat-list, .chat-pill')) this.state.listOpen.set(false);
  }

  @HostListener('document:keydown', ['$event'])
  keys(e: KeyboardEvent): void {
    if (e.key === 'Escape' && this.state.listOpen()) { this.state.listOpen.set(false); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K') && !e.shiftKey) {
      e.preventDefault();
      this.find.set('');
      this.switcher.set(true);
    }
  }
}
