import { Component, HostListener, computed, effect, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { PROJECT_SCOPE } from '../../../core/models/chat.models';
import { BarRow, ChatStateService } from '../../../core/state/chat-state.service';
import { barTime, initials, needsYouLine } from '../../../shared/utils/chat-queue';
import { barSections } from '../../../shared/utils/chat-bar';

/**
 * The chats bar (specs/022 FR-017, FR-039), docked on the left like Messenger: the project chat and every cycle chat,
 * with who answers (a green dot when Claude is on), the last line, unread, typing, drafts, mute, and a "Needs you"
 * section for chats waiting on the user. Slim mode keeps the avatars only. Ctrl+K finds a chat by name.
 */
@Component({
  selector: 'app-chat-bar',
  standalone: true,
  imports: [NgTemplateOutlet],
  template: `
    <nav class="chat-bar" [class.slim]="state.prefs().slim" aria-label="Board chats">
      <div class="bar-head">
        <b>Chats</b>
        <button type="button" class="chat-icon" [title]="state.prefs().slim ? 'Show names' : 'Avatars only'" (click)="state.toggleSlim()">{{ state.prefs().slim ? '»' : '«' }}</button>
      </div>
      <div class="bar-find"><input type="search" placeholder="Find a chat (Ctrl+K)" [value]="find()" (input)="find.set($any($event.target).value)" /></div>
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
      <div class="bar-foot">{{ onCount() }} with Claude on · Ctrl+K</div>
    </nav>

    <ng-template #row let-r>
      <button type="button" class="bar-item" [class.on]="state.openScope() === r.scope" [class.unread]="r.unread > 0"
              [title]="tip(r)" (click)="open(r.scope)">
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
              <button type="button" class="bar-item" [class.on]="i === 0" (click)="open(r.scope); switcher.set(false)">
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

  open(scope: string): void {
    this.state.openChat(this.state.openScope() === scope && this.state.view() !== 'full' ? null : scope);
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

  @HostListener('document:keydown', ['$event'])
  keys(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K') && !e.shiftKey) {
      e.preventDefault();
      this.find.set('');
      this.switcher.set(true);
    }
  }
}
