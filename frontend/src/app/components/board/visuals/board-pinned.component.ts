import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { SnippetOwner, SnippetPage } from '../../../core/models/snippet.models';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { SnippetsApiService } from '../../../core/services/snippets-api.service';
import { MarkdownViewComponent } from '../markdown-view/markdown-view.component';
import { SnippetHostComponent } from './snippet-host.component';

/**
 * 📌 The dashboard at the top of a card or a brief (specs/017 R33): its pinned pages - snippets, diagrams and fixed
 * blocks pinned from a text - shown open, one under the other. Unpin sends one back to the ◈ Pages tabs.
 * Re-read on /ws/board's "pages" signal for this place.
 */
@Component({
  selector: 'app-board-pinned',
  standalone: true,
  imports: [MarkdownViewComponent, SnippetHostComponent],
  template: `
    @if (pinned().length) {
      <div class="board-pinned">
        @for (p of pinned(); track p.id) {
          <section class="board-pinned-item">
            <div class="board-pinned-head">
              <span>📌 {{ p.name }}</span>@if (p.author === 'CLAUDE') { <span class="board-pages-claude" title="Made by Claude">✦</span> }
              <span class="snip-grow"></span>
              @if (canEdit()) { <button type="button" class="board-link" title="Back to the Pages tabs" (click)="unpin(p)">Unpin</button> }
            </div>
            @if (sources()[p.id]; as src) {
              @switch (p.kind) {
                @case ('BLOCK') { <app-markdown-view [text]="src" [snippetContext]="context()" /> }
                @case ('MERMAID') { <app-snippet-host [source]="src" [info]="p.info" kind="mermaid" [snippetId]="p.id" [version]="p.version" [context]="context()" /> }
                @case ('PYTHON') { <app-snippet-host [source]="src" [info]="p.info" kind="python" [snippetId]="p.id" [version]="p.version" [context]="context()" /> }
                @default { <app-snippet-host [source]="src" [info]="p.info" [snippetId]="p.id" [version]="p.version" [context]="context()" /> }
              }
            }
          </section>
        }
        @if (error(); as e) { <div class="board-vis-err">{{ e }}</div> }
      </div>
    }`,
})
export class BoardPinnedComponent {
  /** `card:<id>` or `cycle:<id>` (a cycle's need its project). */
  readonly owner = input.required<string>();
  readonly project = input<string | null>(null);
  readonly canEdit = input(true);
  readonly context = input<Record<string, unknown>>({});

  private readonly api = inject(SnippetsApiService);
  readonly pages = signal<readonly SnippetPage[]>([]);
  readonly pinned = computed(() => this.pages().filter((p) => p.pinned));
  /** Each pinned page's source, by id, at the version listed. */
  readonly sources = signal<Readonly<Record<string, string>>>({});
  readonly error = signal<string | null>(null);
  private loaded: Record<string, number> = {};

  constructor() {
    effect(() => {
      this.owner();
      untracked(() => void this.load());
    });
    const sub = inject(BoardSocketService).events$.subscribe((e) => {
      if (e.type !== 'board-changed' || e.what !== 'pages') return;
      const [kind, id] = this.owner().split(/:(.*)/s);
      if ((kind === 'card' && e.cardId === id) || (kind === 'cycle' && e.cycleId === id)) void this.load();
    });
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }

  async load(): Promise<void> {
    try {
      const list = await firstValueFrom(this.api.pages(this.owner() as SnippetOwner, this.project()));
      this.pages.set(list);
      const next: Record<string, string> = {};
      for (const p of list.filter((x) => x.pinned)) {
        if (this.loaded[p.id] === p.version && this.sources()[p.id] !== undefined) { next[p.id] = this.sources()[p.id]; continue; }
        const full = await firstValueFrom(this.api.page(p.id));
        this.loaded[p.id] = full.version;
        next[p.id] = full.source ?? '';
      }
      this.sources.set(next);
      this.error.set(null);
    } catch {
      this.pages.set([]);
    }
  }

  async unpin(p: SnippetPage): Promise<void> {
    try {
      await firstValueFrom(this.api.update(p.id, { pinned: false }));
      await this.load();
    } catch (e) {
      this.error.set((e as { error?: { message?: string } })?.error?.message ?? 'Could not unpin');
    }
  }
}
