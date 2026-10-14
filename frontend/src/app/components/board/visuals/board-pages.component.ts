import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { SnippetKind, SnippetOwner, SnippetPage } from '../../../core/models/snippet.models';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { ConfirmDialogService } from '../../../core/services/confirm-dialog.service';
import { SnippetsApiService } from '../../../core/services/snippets-api.service';
import { VISUAL_TEMPLATES, infoAttrs } from '../../../shared/utils/board-visuals';
import { SnippetHostComponent } from './snippet-host.component';
import { SnippetVersionsComponent } from './snippet-versions.component';
import { VisualEditorComponent } from './visual-editor.component';

/**
 * ◈ Pages (specs/017 R29, R30, R32): named HTML pages and diagrams attached to a card, a cycle or a project, shown as
 * tabs and run in the locked frame. New, edit (with live preview), versions with their diff, pop-out into a window of
 * its own, pin first, delete. Re-read on /ws/board's "pages" signal for this place - no polling.
 */
@Component({
  selector: 'app-board-pages',
  standalone: true,
  imports: [SnippetHostComponent, VisualEditorComponent, SnippetVersionsComponent],
  template: `
    <div class="board-pages" [class.empty]="!pages().length">
      <div class="board-pages-tabs" role="tablist">
        @if (pages().length) { <span class="board-pages-label">◈ Pages</span> }
        @for (p of pages(); track p.id) {
          <button type="button" role="tab" class="board-tab" [class.on]="p.id === selectedId()" [attr.aria-selected]="p.id === selectedId()"
                  (click)="select(p.id)">{{ p.pinned ? '📌 ' : '' }}{{ p.kind === 'MERMAID' ? '⬡ ' : '' }}{{ p.name }}
            @if (p.author === 'CLAUDE') { <span class="board-pages-claude" title="Made by Claude">✦</span> }</button>
        }
        @if (canEdit()) {
          <span class="board-editor-dd">
            <button type="button" class="board-link board-pages-new" (click)="newMenu.set(!newMenu())" title="A page of HTML, CSS and JavaScript, or a diagram, that stays with this {{ placeName() }}">＋ Page</button>
            @if (newMenu()) {
              <span class="board-editor-dd-menu">
                <button type="button" class="board-editor-swatch" (click)="startNew('HTML')">◈ HTML page</button>
                <button type="button" class="board-editor-swatch" (click)="startNew('MERMAID')">⬡ Diagram</button>
              </span>
            }
          </span>
        }
      </div>
      @if (selected(); as p) {
        <div class="board-page-bar">
          <span class="board-dim">v{{ p.version }} · {{ p.updatedBy === 'CLAUDE' ? '✦ Claude' : 'You' }} · {{ when(p.updatedAt) }}</span>
          <span class="snip-grow"></span>
          @if (canEdit()) { <button type="button" class="board-link" (click)="edit(p)">✎ Edit</button> }
          <button type="button" class="board-link" (click)="versionsOf.set(p)">⟲ Versions</button>
          <button type="button" class="board-link" title="Open in a window of its own" (click)="popOut(p)">⧉ Pop out</button>
          @if (canEdit()) {
            <button type="button" class="board-link" [title]="p.pinned ? 'Unpin' : 'Pin first - the dashboard of this ' + placeName()" (click)="pin(p)">{{ p.pinned ? '📌 Unpin' : '📌 Pin' }}</button>
            <button type="button" class="board-link danger" (click)="remove(p)">🗑</button>
          }
        </div>
        @if (source(); as src) {
          <app-snippet-host [source]="src" [info]="p.info" [kind]="p.kind === 'MERMAID' ? 'mermaid' : 'html'" [snippetId]="p.id" [version]="p.version"
                            [context]="context()" />
        }
      }
      @if (error(); as e) { <div class="board-vis-err">{{ e }}</div> }
    </div>
    @if (editing(); as ed) {
      <app-visual-editor [lang]="ed.kind === 'MERMAID' ? 'mermaid' : 'html'" [source]="ed.source" [info]="ed.info"
                         [saveLabel]="ed.page ? 'Save' : 'Create page'" (saved)="save($event)" (closed)="editing.set(null)" />
    }
    @if (versionsOf(); as v) {
      <app-snippet-versions [page]="v" [canEdit]="canEdit()" (restored)="restored($event)" (closed)="versionsOf.set(null)" />
    }`,
})
export class BoardPagesComponent {
  /** `card:<id>`, `cycle:<id>` or `project:<name>`. */
  readonly owner = input.required<string>();
  /** A cycle's pages need their project. */
  readonly project = input<string | null>(null);
  readonly canEdit = input(true);
  readonly context = input<Record<string, unknown>>({});

  private readonly api = inject(SnippetsApiService);
  private readonly confirm = inject(ConfirmDialogService);
  readonly pages = signal<readonly SnippetPage[]>([]);
  readonly selectedId = signal<string | null>(null);
  readonly selected = computed(() => this.pages().find((p) => p.id === this.selectedId()) ?? null);
  /** The selected page's source at its version. */
  readonly source = signal<string | null>(null);
  readonly newMenu = signal(false);
  readonly editing = signal<{ page: SnippetPage | null; kind: SnippetKind; source: string; info: string } | null>(null);
  readonly versionsOf = signal<SnippetPage | null>(null);
  readonly error = signal<string | null>(null);
  readonly placeName = computed(() => this.owner().split(':')[0]);
  private loadedVersion = '';

  constructor() {
    effect(() => {
      this.owner();
      untracked(() => void this.load());
    });
    const sub = inject(BoardSocketService).events$.subscribe((e) => {
      if (e.type !== 'board-changed' || e.what !== 'pages') return;
      const [kind, id] = [this.placeName(), this.owner().slice(this.placeName().length + 1)];
      if ((kind === 'card' && e.cardId === id) || (kind === 'cycle' && e.cycleId === id) || (kind === 'project' && e.project === id && !e.cardId && !e.cycleId)) {
        void this.load();
      }
    });
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }

  async load(): Promise<void> {
    try {
      const list = await firstValueFrom(this.api.pages(this.owner() as SnippetOwner, this.project()));
      this.pages.set(list);
      this.error.set(null);
      const keep = list.find((p) => p.id === this.selectedId());
      await this.select(keep?.id ?? list[0]?.id ?? null);
    } catch {
      this.pages.set([]);
    }
  }

  async select(id: string | null): Promise<void> {
    this.selectedId.set(id);
    const p = this.selected();
    if (!p) { this.source.set(null); this.loadedVersion = ''; return; }
    const key = `${p.id}@${p.version}`;
    if (key === this.loadedVersion) return;
    try {
      const full = await firstValueFrom(this.api.page(p.id));
      if (this.selectedId() !== p.id) return;
      this.loadedVersion = `${full.id}@${full.version}`;
      this.pages.update((list) => list.map((x) => (x.id === full.id ? { ...full, source: null } : x)));
      this.source.set(full.source ?? '');
    } catch {
      this.error.set('Could not open the page');
    }
  }

  startNew(kind: SnippetKind): void {
    this.newMenu.set(false);
    const n = this.pages().length + 1;
    this.editing.set({
      page: null, kind,
      source: kind === 'MERMAID' ? VISUAL_TEMPLATES['mermaid'] : VISUAL_TEMPLATES['html'],
      info: kind === 'MERMAID' ? '' : `live name="Page ${n}"`,
    });
  }

  edit(p: SnippetPage): void {
    this.editing.set({ page: p, kind: p.kind, source: this.source() ?? '', info: withName(p.info, p.name, p.kind) });
  }

  async save(out: { text: string; info: string }): Promise<void> {
    const ed = this.editing();
    if (!ed) return;
    const name = (infoAttrs(out.info)['name'] ?? '').trim() || ed.page?.name || (ed.kind === 'MERMAID' ? `Diagram ${this.pages().length + 1}` : `Page ${this.pages().length + 1}`);
    try {
      const saved = ed.page
        ? await firstValueFrom(this.api.update(ed.page.id, { name, info: out.info, source: out.text, baseVersion: ed.page.version }))
        : await firstValueFrom(this.api.create({ owner: this.owner() as SnippetOwner, project: this.project(), name, kind: ed.kind, info: out.info, source: out.text }));
      this.editing.set(null);
      this.error.set(null);
      this.selectedId.set(saved.id);
      await this.load();
    } catch (e: unknown) {
      this.error.set(message(e, 'Could not save the page'));
      this.editing.set(null);
    }
  }

  async restored(p: SnippetPage): Promise<void> {
    this.versionsOf.set(null);
    this.selectedId.set(p.id);
    await this.load();
  }

  async pin(p: SnippetPage): Promise<void> {
    try {
      await firstValueFrom(this.api.update(p.id, { pinned: !p.pinned }));
      await this.load();
    } catch (e) {
      this.error.set(message(e, 'Could not pin'));
    }
  }

  async remove(p: SnippetPage): Promise<void> {
    if (!(await this.confirm.confirm(`Delete the page "${p.name}" and all its versions?`))) return;
    try {
      await firstValueFrom(this.api.delete(p.id));
      if (this.selectedId() === p.id) this.selectedId.set(null);
      await this.load();
    } catch (e) {
      this.error.set(message(e, 'Could not delete'));
    }
  }

  popOut(p: SnippetPage): void {
    window.open(`/board/page/${encodeURIComponent(p.id)}`, `alfred-page-${p.id}`, 'width=1100,height=800');
  }

  when(at: string): string {
    return new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
}

/** The editor reads the page's name from its settings: keep them in step. */
function withName(info: string, name: string, kind: SnippetKind): string {
  if (kind === 'MERMAID') return info;
  const rest = info.replace(/(^|\s)name=("[^"]*"|'[^']*'|\S+)/, ' ').trim();
  return `${rest || 'live'} name="${name.replace(/"/g, "'")}"`.replace(/^live\s+live\b/, 'live');
}

function message(e: unknown, fallback: string): string {
  return (e as { error?: { message?: string } })?.error?.message || fallback;
}
