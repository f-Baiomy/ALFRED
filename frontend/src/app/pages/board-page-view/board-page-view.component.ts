import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { SnippetPage } from '../../core/models/snippet.models';
import { BoardSocketService } from '../../core/services/board-socket.service';
import { SnippetsApiService } from '../../core/services/snippets-api.service';
import { SnippetHostComponent } from '../../components/board/visuals/snippet-host.component';

/**
 * A board page alone in a window (specs/017 R30): `/board/page/<id>`, opened by ⧉ Pop out. The same locked frame and
 * bridge as on the card; a new version saved anywhere shows here at once (/ws/board "pages").
 */
@Component({
  selector: 'app-board-page-view',
  standalone: true,
  imports: [SnippetHostComponent],
  template: `
    <div class="board-page-view">
      @if (page(); as p) {
        <app-snippet-host [source]="p.source ?? ''" [info]="pageInfo(p)" [kind]="p.kind === 'MERMAID' ? 'mermaid' : 'html'"
                          [snippetId]="p.id" [version]="p.version" [context]="{ project: p.project, cardId: p.cardId, cycleId: p.cycleId }" />
      } @else {
        <p class="board-dim">{{ error() ?? 'Opening…' }}</p>
      }
    </div>`,
})
export class BoardPageViewComponent implements OnInit {
  private readonly api = inject(SnippetsApiService);
  private readonly route = inject(ActivatedRoute);
  readonly page = signal<SnippetPage | null>(null);
  readonly error = signal<string | null>(null);

  constructor() {
    const sub = inject(BoardSocketService).events$.subscribe((e) => {
      const p = this.page();
      if (p && e.type === 'board-changed' && e.what === 'pages' && (e.cardId === p.cardId || e.cycleId === p.cycleId || e.project === p.project)) {
        void this.load();
      }
    });
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id') ?? '';
    try {
      const p = await firstValueFrom(this.api.page(id));
      if (p.version !== this.page()?.version || p.source !== this.page()?.source) this.page.set(p);
      document.title = `${p.name} - Alfred`;
    } catch {
      this.page.set(null);
      this.error.set('This page does not exist any more.');
    }
  }

  /** Alone in a window, a page may be as tall as it likes. */
  pageInfo(p: SnippetPage): string {
    return /(^|\s)page(\s|$)/.test(p.info) ? p.info : `${p.info} page`.trim();
  }
}
