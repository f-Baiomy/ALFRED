import { Component, HostListener, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { SnippetPage, SnippetVersionInfo } from '../../../core/models/snippet.models';
import { SnippetsApiService } from '../../../core/services/snippets-api.service';
import { diffLines } from '../../../shared/utils/interception-diff';
import { MarkdownViewComponent } from '../markdown-view/markdown-view.component';
import { SnippetHostComponent } from './snippet-host.component';

/**
 * ⟲ Versions of a page (specs/017 R32): every save, the line diff between any two, both drawn side by side, and
 * Restore - which saves the old one again as the newest version (nothing is lost).
 */
@Component({
  selector: 'app-snippet-versions',
  standalone: true,
  imports: [MarkdownViewComponent, SnippetHostComponent],
  template: `
    <div class="run-dialog-bg" (click)="closed.emit()">
      <div class="vis-ed snip-versions" role="dialog" aria-label="Versions" (click)="$event.stopPropagation()">
        <div class="vis-ed-head"><b>⟲ Versions of {{ page().name }}</b><span class="vis-ed-grow"></span>
          <span class="vis-ed-modes">
            <button type="button" class="board-link" [class.on]="mode() === 'diff'" (click)="mode.set('diff')">± Changes</button>
            <button type="button" class="board-link" [class.on]="mode() === 'side'" (click)="mode.set('side')">⇆ Side by side</button>
          </span></div>
        <div class="snip-versions-body">
          <div class="snip-versions-list">
            @for (v of versions(); track v.version) {
              <div class="snip-version" [class.a]="v.version === a()" [class.b]="v.version === b()">
                <b>v{{ v.version }}</b> <span class="board-dim">{{ v.author === 'CLAUDE' ? '✦ Claude' : 'You' }} · {{ when(v.at) }} · {{ kb(v.size) }}</span>
                <span class="snip-version-pick">
                  <button type="button" class="board-link" [class.on]="v.version === a()" title="Compare from this one" (click)="pick('a', v.version)">A</button>
                  <button type="button" class="board-link" [class.on]="v.version === b()" title="Compare to this one" (click)="pick('b', v.version)">B</button>
                  @if (v.version !== page().version && canEdit()) {
                    <button type="button" class="board-link" (click)="restore(v)">↶ Restore</button>
                  }
                </span>
              </div>
            } @empty { <div class="board-dim">Loading…</div> }
          </div>
          <div class="snip-versions-view">
            @if (error(); as e) { <div class="board-vis-err">{{ e }}</div> }
            @if (mode() === 'diff') {
              <pre class="snip-diff" dir="ltr">@for (l of diff(); track $index) {<span [class]="'snip-diff-' + l.kind">{{ l.kind === 'added' ? '+ ' : l.kind === 'removed' ? '- ' : '  ' }}{{ l.text }}</span>
}</pre>
              @if (!diff().length) { <div class="board-dim">Pick two versions.</div> }
            } @else {
              <div class="snip-side">
                <div><div class="board-dim">v{{ a() }}</div>@if (srcA() !== null) { @if (page().kind === 'BLOCK') { <app-markdown-view [text]="srcA()!" /> } @else { <app-snippet-host [source]="srcA()!" [info]="infoA()" [kind]="kind()" /> } }</div>
                <div><div class="board-dim">v{{ b() }}</div>@if (srcB() !== null) { @if (page().kind === 'BLOCK') { <app-markdown-view [text]="srcB()!" /> } @else { <app-snippet-host [source]="srcB()!" [info]="infoB()" [kind]="kind()" /> } }</div>
              </div>
            }
          </div>
        </div>
        <div class="vis-ed-foot"><span class="board-dim">Every save is kept. Restoring saves that version again as the newest.</span>
          <span><button type="button" class="action-btn" (click)="closed.emit()">Close</button></span></div>
      </div>
    </div>`,
})
export class SnippetVersionsComponent implements OnInit {
  readonly page = input.required<SnippetPage>();
  readonly canEdit = input(true);
  readonly restored = output<SnippetPage>();
  readonly closed = output<void>();

  private readonly api = inject(SnippetsApiService);
  readonly versions = signal<readonly SnippetVersionInfo[]>([]);
  readonly mode = signal<'diff' | 'side'>('diff');
  readonly a = signal(0);
  readonly b = signal(0);
  readonly srcA = signal<string | null>(null);
  readonly srcB = signal<string | null>(null);
  readonly infoA = signal('');
  readonly infoB = signal('');
  readonly error = signal<string | null>(null);
  readonly kind = computed(() => (this.page().kind === 'MERMAID' ? 'mermaid' : this.page().kind === 'PYTHON' ? 'python' : 'html') as 'html' | 'mermaid' | 'python');
  readonly diff = computed(() => (this.srcA() === null || this.srcB() === null ? [] : diffLines(this.srcA(), this.srcB(), 'text', false)));
  private readonly sources = new Map<number, { source: string; info: string }>();

  async ngOnInit(): Promise<void> {
    try {
      const list = await firstValueFrom(this.api.versions(this.page().id));
      this.versions.set(list);
      const newest = list[0]?.version ?? this.page().version;
      await this.pick('b', newest);
      await this.pick('a', list[1]?.version ?? newest);
    } catch {
      this.error.set('Could not read the versions');
    }
  }

  @HostListener('document:keydown.escape')
  escape(): void {
    this.closed.emit();
  }

  async pick(side: 'a' | 'b', version: number): Promise<void> {
    (side === 'a' ? this.a : this.b).set(version);
    const v = await this.source(version);
    if (!v) return;
    if (side === 'a') { this.srcA.set(v.source); this.infoA.set(v.info); } else { this.srcB.set(v.source); this.infoB.set(v.info); }
  }

  private async source(version: number): Promise<{ source: string; info: string } | null> {
    const kept = this.sources.get(version);
    if (kept) return kept;
    try {
      const p = await firstValueFrom(this.api.page(this.page().id, version));
      const v = { source: p.source ?? '', info: p.info };
      this.sources.set(version, v);
      return v;
    } catch {
      this.error.set(`Could not read version ${version}`);
      return null;
    }
  }

  async restore(v: SnippetVersionInfo): Promise<void> {
    const old = await this.source(v.version);
    if (!old) return;
    try {
      const saved = await firstValueFrom(this.api.update(this.page().id, { name: v.name, info: old.info, source: old.source, baseVersion: this.page().version }));
      this.restored.emit(saved);
    } catch (e: unknown) {
      this.error.set((e as { error?: { message?: string } })?.error?.message ?? 'Could not restore');
    }
  }

  when(at: string): string {
    return new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  kb(size: number): string {
    return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;
  }
}
