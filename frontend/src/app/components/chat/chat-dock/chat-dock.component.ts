import { Component, DestroyRef, afterNextRender, computed, effect, inject, untracked } from '@angular/core';
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
const BAR = { full: 268, slim: 64 };

/**
 * Where the board chats live on every tab (specs/022 FR-017): the chats bar docked on the left, the open chat beside it
 * (docked, expanded or full screen), the page pushed right by what they take. It follows the page: a board's project, a
 * cycle's chat when a cycle is in view, and a chat mention clicked anywhere.
 */
@Component({
  selector: 'app-chat-dock',
  standalone: true,
  imports: [ChatBarComponent, ChatPanelComponent],
  template: `
    <div class="chat-rail" [class.full]="state.view() === 'full' && !!state.openScope()">
      <app-chat-bar />
      <app-chat-panel />
      @if (state.splitScope() && state.openScope() && state.view() !== 'full') { <app-chat-panel [second]="true" /> }
    </div>`,
})
export class ChatDockComponent {
  readonly state = inject(ChatStateService);
  private readonly router = inject(Router);
  private readonly desk = inject(DesktopNotificationsService);
  private readonly db = inject(DbCaptureApiService);
  private readonly lastIds = new Map<string, number>();
  private readonly needs = new Map<string, number>();

  /** How far the page moves right: the bar, plus the open chat when it is docked or expanded. */
  readonly offset = computed(() => {
    const bar = this.state.prefs().slim ? BAR.slim : BAR.full;
    if (!this.state.openScope()) return bar;
    const v = this.state.view();
    if (v === 'full') return bar;
    if (v === 'expanded') return bar + Math.min(window.innerWidth * 0.62, 1000);
    return bar + this.state.prefs().width;
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    effect(() => document.documentElement.style.setProperty('--chat-offset', `${this.offset()}px`));
    // the rail starts under the tab nav, whatever its height (it wraps on a narrow window)
    afterNextRender(() => {
      const nav = document.querySelector('.tab-nav');
      if (!nav || typeof ResizeObserver === 'undefined') return;
      const set = () => document.documentElement.style.setProperty('--chat-top', `${nav.getBoundingClientRect().bottom}px`);
      const ro = new ResizeObserver(set);
      ro.observe(nav);
      set();
      destroyRef.onDestroy(() => ro.disconnect());
    });
    destroyRef.onDestroy(() => {
      document.documentElement.style.removeProperty('--chat-offset');
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

  /** The project and the cycle in view from the URL: /board?project=&cycle=, /cycles/<id>. */
  private follow(url: string): void {
    const u = new URL(url, 'http://x');
    const cycle = /^\/cycles\/([^/?#]+)/.exec(u.pathname)?.[1] ?? u.searchParams.get('cycle');
    const project = u.searchParams.get('project');
    if (project != null) {
      try { localStorage.setItem(LAST_PROJECT, project); } catch { /* private mode */ }
      this.state.show(project, cycle);
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
