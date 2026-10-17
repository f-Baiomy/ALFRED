import { Component, DestroyRef, afterNextRender, effect, inject, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map } from 'rxjs';
import { ChatStateService } from '../../../core/state/chat-state.service';
import { needsYouCount } from '../../../core/models/chat.models';
import { shouldNotify } from '../../../shared/utils/chat-bar';
import { BoardMentionsService } from '../../../core/services/board-mentions.service';
import { DbCaptureApiService } from '../../../core/services/db-capture-api.service';
import { DesktopNotificationsService } from '../../../core/services/desktop-notifications.service';
import { ChatBarComponent } from '../chat-bar/chat-bar.component';
import { ChatPanelComponent } from '../chat-panel/chat-panel.component';

const LAST_PROJECT = 'alfred.chat.project';

/**
 * Where the board chats live on every tab (specs/022 FR-017): a pill floating bottom-right (or left, where the user dragged
 * it) with the open chats as windows above it - the page keeps its full width. It follows the page: a board's project, a
 * cycle's chat when a cycle is in view, and a chat mention clicked anywhere.
 */
@Component({
  selector: 'app-chat-dock',
  standalone: true,
  imports: [ChatBarComponent, ChatPanelComponent],
  template: `
    <div class="chat-float" [class.left]="state.prefs().side === 'left'" [class.full]="state.view() === 'full' && !!state.openScope()">
      <div class="chat-wins">
        <app-chat-panel />
        @if (state.splitScope() && state.openScope() && state.view() !== 'full') { <app-chat-panel [second]="true" /> }
      </div>
      <div class="chat-pillrow"><app-chat-bar /></div>
    </div>`,
})
export class ChatDockComponent {
  readonly state = inject(ChatStateService);
  private readonly router = inject(Router);
  private readonly desk = inject(DesktopNotificationsService);
  private readonly db = inject(DbCaptureApiService);
  private readonly lastIds = new Map<string, number>();
  private readonly needs = new Map<string, number>();


  constructor() {
    const destroyRef = inject(DestroyRef);
    // Full screen: the page behind neither shows nor scrolls.
    effect(() => {
      const full = this.state.view() === 'full' && !!this.state.openScope();
      document.documentElement.classList.toggle('chat-fullscreen', full);
    });
    destroyRef.onDestroy(() => document.documentElement.classList.remove('chat-fullscreen'));
    // the rail starts under the tab nav, whatever its height (it wraps on a narrow window)
    afterNextRender(() => {
      const nav = document.querySelector('.tab-nav');
      if (!nav || typeof ResizeObserver === 'undefined') return;
      // never below 0: a page scrolled past the nav would otherwise make the window taller than the screen
      const set = () => document.documentElement.style.setProperty('--chat-top', `${Math.max(0, nav.getBoundingClientRect().bottom)}px`);
      const ro = new ResizeObserver(set);
      ro.observe(nav);
      // zooming changes the viewport, not always the nav's box: measure again then too
      window.addEventListener('resize', set);
      set();
      destroyRef.onDestroy(() => { ro.disconnect(); window.removeEventListener('resize', set); });
    });
    destroyRef.onDestroy(() => {
      document.documentElement.style.removeProperty('--chat-top');
    });

    this.router.events.pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd), map((e) => e.urlAfterRedirects), takeUntilDestroyed(destroyRef))
      .subscribe((url) => this.follow(url));
    this.follow(this.router.url);

    const mentions = inject(BoardMentionsService);
    effect(() => {
      const target = mentions.chatToOpen();
      if (!target) return;
      untracked(() => {
        mentions.chatToOpen.set(null);
        this.state.show(target.project, this.state.cycleInView());
        this.state.openChat(target.scope, target.messageId);
      });
    });

    // A new answer in a chat the user is not reading: a desktop notification, as that chat's level allows (FR-042).
    effect(() => {
      const rows = this.state.rows();
      untracked(() => {
        for (const r of rows) {
          const before = this.lastIds.get(r.scope);
          const needsBefore = this.needs.get(r.scope) ?? 0;
          this.lastIds.set(r.scope, r.lastId ?? 0);
          this.needs.set(r.scope, needsYouCount(r.needsYou));
          if (before == null || (r.lastId ?? 0) <= before || !shouldNotify(r, needsBefore)) continue;
          if (!this.state.prefs().notify || (!document.hidden && this.state.openScope() === r.scope)) continue;
          this.desk.notify(`${r.label} · Claude`, { body: r.lastPreview, tag: `alfred-chat-${r.scope}` });
        }
      });
    });
  }

  /** The board whose chat was last folded in on opening it: × keeps it closed until another board is opened. */
  private foldedFor: string | null = null;

  /** The project and the cycle (or board) in view from the URL: /board?project=&board=, /board?cycle=, /cycles/<id>. */
  /**
   * Opening a board puts its chat beside the pill, folded (specs/029) - even before its first message, when the chat
   * list would not show it - unless that chat is open already. Once per board opened, so × is not undone by a ?card=.
   */
  private foldIn(board: string | null): void {
    if (board === this.foldedFor) return;
    this.foldedFor = board;
    if (!board || board === this.state.openScope() || board === this.state.splitScope()) return;
    this.state.minimize(board);
  }

  private follow(url: string): void {
    const u = new URL(url, 'http://x');
    const board = u.pathname.startsWith('/board') ? u.searchParams.get('board') : null;
    const cycle = /^\/cycles\/([^/?#]+)/.exec(u.pathname)?.[1] ?? board ?? u.searchParams.get('cycle');
    const project = u.searchParams.get('project');
    if (project != null) {
      try { localStorage.setItem(LAST_PROJECT, project); } catch { /* private mode */ }
      this.state.show(project, cycle);
      this.foldIn(board);
      return;
    }
    let last: string | null = null;
    try { last = localStorage.getItem(LAST_PROJECT); } catch { /* private mode */ }
    if (last != null || this.state.project()) {
      this.state.show(this.state.project() || last || '', cycle);
      return;
    }
    // first visit: the first project Alfred knows
    this.db.projects().subscribe({
      next: (ps) => this.state.show(ps[0]?.project ?? '', cycle),
      error: () => this.state.show('', cycle),
    });
  }
}
