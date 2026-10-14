import { Component, computed, input, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Block, CALLOUT_TITLES, Inline, headingsOf, markdownSections } from '../../../shared/utils/markdown-blocks';
import { textBlocks } from '../../../shared/utils/rich-html';
import { CODE_LANGS, langOf } from '../../../shared/utils/code-highlight';
import { MentionChipComponent } from '../mention-chip/mention-chip.component';
import { VariablePillComponent } from '../variable-pill/variable-pill.component';
import { CallMiniComponent } from '../call-mini/call-mini.component';
import { DirChoice, blockDir, inlineWords } from '../../../shared/utils/text-direction';
import { copyToClipboard } from '../../../shared/utils/clipboard';
import { ChartBlockComponent } from '../visuals/chart-block.component';
import { StatsBlockComponent } from '../visuals/stats-block.component';
import { TimelineBlockComponent } from '../visuals/timeline-block.component';
import { SnippetHostComponent } from '../visuals/snippet-host.component';

/**
 * A board text - Markdown or the editor's HTML (docs/board.md "Rich text") - rendered from the typed tree with plain
 * bindings, never innerHTML, since spec files, comments and Claude's text are untrusted (constitution I). Headings carry
 * their slug as an id, so a spec mention's #section can scroll to it. Every block reads in its own direction.
 */
@Component({
  selector: 'app-markdown-view',
  standalone: true,
  imports: [NgTemplateOutlet, MentionChipComponent, VariablePillComponent, CallMiniComponent, ChartBlockComponent, StatsBlockComponent, SnippetHostComponent,
    TimelineBlockComponent],
  template: `
    <ng-template #inl let-nodes>
      @for (n of asInlines(nodes); track $index) {
        @switch (n.kind) {
          @case ('text') { <span class="board-md-text">{{ n.text }}</span> }
          @case ('code') { <code dir="ltr">{{ n.text }}</code> }
          @case ('bold') { <strong><ng-container *ngTemplateOutlet="inl; context: { $implicit: kids(n) }" /></strong> }
          @case ('italic') { <em><ng-container *ngTemplateOutlet="inl; context: { $implicit: kids(n) }" /></em> }
          @case ('underline') { <u><ng-container *ngTemplateOutlet="inl; context: { $implicit: kids(n) }" /></u> }
          @case ('strike') { <s><ng-container *ngTemplateOutlet="inl; context: { $implicit: kids(n) }" /></s> }
          @case ('mark') { <mark class="board-md-mark"><ng-container *ngTemplateOutlet="inl; context: { $implicit: kids(n) }" /></mark> }
          @case ('sub') { <sub><ng-container *ngTemplateOutlet="inl; context: { $implicit: kids(n) }" /></sub> }
          @case ('sup') { <sup><ng-container *ngTemplateOutlet="inl; context: { $implicit: kids(n) }" /></sup> }
          @case ('kbd') { <kbd><ng-container *ngTemplateOutlet="inl; context: { $implicit: kids(n) }" /></kbd> }
          @case ('color') { <span [class]="'board-md-c-' + colorOf(n)"><ng-container *ngTemplateOutlet="inl; context: { $implicit: kids(n) }" /></span> }
          @case ('link') { <a [href]="hrefOf(n)" target="_blank" rel="noopener noreferrer"><ng-container *ngTemplateOutlet="inl; context: { $implicit: kids(n) }" /></a> }
          @case ('mention') { <app-mention-chip [mention]="refOf(n)" [showPreview]="previews()" /> }
          @case ('variable') { <app-variable-pill [name]="varOf(n)" /> }
          @case ('pill') { <span [class]="'board-md-pill ' + toneOf(n)">{{ pillIcon(n) }} {{ textOf(n) }}</span> }
          @case ('br') { <br /> }
        }
      }
    </ng-template>
    <ng-template #blk let-blocks let-path="path">
      @for (b of asBlocks(blocks); track $index; let bi = $index) {
        @switch (b.kind) {
          @case ('heading') {
            <div class="board-md-h" [class]="'board-md-h board-md-h' + b.level" [id]="idPrefix() + b.slug" [attr.dir]="dirOf(b.inlines)">
              <ng-container *ngTemplateOutlet="inl; context: { $implicit: b.inlines }" />
              @if (specFile()) {
                <button type="button" class="board-md-anchor" title="Copy a link to this heading (a spec mention)" (click)="copyHeading(b)">{{ copied() === b.slug ? '✓' : '#' }}</button>
              }
            </div>
          }
          @case ('paragraph') {
            @if (callCard(b); as ref) {
              <div class="board-md-callrow"><app-call-mini [mention]="ref" /></div>
            } @else {
              <p [attr.dir]="dirOf(b.inlines)"><ng-container *ngTemplateOutlet="inl; context: { $implicit: b.inlines }" /></p>
            }
          }
          @case ('list') {
            @if (b.checks; as checks) {
              <ul class="board-md-checklist" [attr.dir]="dirOfAll(b.items)">@for (item of b.items; track $index; let i = $index) {
                <li [attr.dir]="dirOf(item)" [class.done]="checks[i]"><span class="board-md-check">{{ checks[i] ? '☑' : '☐' }}</span><ng-container *ngTemplateOutlet="inl; context: { $implicit: item }" /></li> }</ul>
            } @else if (b.ordered) {
              <ol [attr.dir]="dirOfAll(b.items)">@for (item of b.items; track $index) { <li [attr.dir]="dirOf(item)"><ng-container *ngTemplateOutlet="inl; context: { $implicit: item }" /></li> }</ol>
            } @else {
              <ul [attr.dir]="dirOfAll(b.items)">@for (item of b.items; track $index) { <li [attr.dir]="dirOf(item)"><ng-container *ngTemplateOutlet="inl; context: { $implicit: item }" /></li> }</ul>
            }
          }
          @case ('code') {
            <div class="board-md-code" dir="ltr" [class.wrap]="wraps(path + '/' + bi)" [class.lines]="numbered().has(path + '/' + bi)">
              <div class="board-md-code-bar">
                <span>{{ langLabel(b.lang) }} · {{ lineCount(b.text) }} {{ lineCount(b.text) === 1 ? 'line' : 'lines' }}</span>
                <span class="board-md-code-acts">
                  <button type="button" class="board-link" [class.on]="numbered().has(path + '/' + bi)" (click)="toggle(numbered, path + '/' + bi)"
                          [title]="numbered().has(path + '/' + bi) ? 'Hide line numbers' : 'Show line numbers'"># lines</button>
                  <button type="button" class="board-link on" (click)="toggle(flipped, path + '/' + bi)"
                          [title]="wraps(path + '/' + bi) ? 'Long lines wrap - click to keep each line whole and scroll sideways' : 'Long lines scroll sideways - click to wrap them'">
                    {{ wraps(path + '/' + bi) ? '⤶ wrap' : '⇥ scroll' }}</button>
                  <button type="button" class="board-link" (click)="copyCode(path + '/' + bi, b.text)">{{ copied() === path + '/' + bi ? '✓ copied' : '⧉ copy' }}</button>
                </span>
              </div>
              @if (codeTokens(b); as tokens) {
                <pre class="board-md-pre" dir="ltr" [class.board-md-json]="b.lang === 'json'">@for (line of linesOf(tokens); track $index) {<span class="board-md-line">@for (t of line; track $index) {@if (t.kind) {<span [class]="'tok-' + t.kind">{{ t.text }}</span>} @else {<ng-container>{{ t.text }}</ng-container>}}</span>}</pre>
              } @else {
                <pre class="board-md-pre" dir="ltr">@for (line of b.text.split('\\n'); track $index) {<span class="board-md-line">{{ line }}{{ '\\n' }}</span>}</pre>
              }
            </div>
          }
          @case ('quote') { <blockquote class="board-md-quote" [attr.dir]="dirOf(b.inlines)"><ng-container *ngTemplateOutlet="inl; context: { $implicit: b.inlines }" /></blockquote> }
          @case ('facts') {
            <div class="board-md-facts" [attr.dir]="dir() === 'auto' ? 'auto' : dir()">
              @for (f of b.facts; track $index) {
                <span class="board-md-fact" [class.bad]="f.tone === 'bad'" [class.warn]="f.tone === 'warn'"><ng-container *ngTemplateOutlet="inl; context: { $implicit: f.inlines }" /></span>
              }
            </div>
          }
          @case ('callout') {
            <div [class]="'board-md-callout-box ' + b.tone" [attr.dir]="dirOfBlocks(b.title, b.blocks)">
              <div class="board-md-callout-title">{{ calloutIcon(b.tone) }} @if (b.title.length) { <ng-container *ngTemplateOutlet="inl; context: { $implicit: b.title }" /> } @else { {{ calloutTitle(b.tone) }} }</div>
              <ng-container *ngTemplateOutlet="blk; context: { $implicit: b.blocks, path: path + '/' + bi }" />
            </div>
          }
          @case ('fold') {
            <details class="board-md-fold" [attr.dir]="dirOfBlocks(b.summary, b.blocks)">
              <summary><ng-container *ngTemplateOutlet="inl; context: { $implicit: b.summary }" /></summary>
              <ng-container *ngTemplateOutlet="blk; context: { $implicit: b.blocks, path: path + '/' + bi }" />
            </details>
          }
          @case ('image') {
            <img class="board-md-img" [src]="imageSrc(b.src)" [alt]="b.alt" loading="lazy" (click)="zoom.set(imageSrc(b.src))" />
          }
          @case ('rule') { <hr /> }
          @case ('visual') {
            @switch (b.lang) {
              @case ('stats') { <app-stats-block [source]="b.text" /> }
              @case ('chart') { <app-chart-block [source]="b.text" /> }
              @case ('timeline') { <app-timeline-block [source]="b.text" /> }
              @case ('html') { <app-snippet-host [source]="b.text" [info]="b.info" [dir]="dir() === 'auto' ? 'auto' : dir()" [context]="snippetContext()" /> }
              @case ('mermaid') { <app-snippet-host [source]="b.text" [info]="b.info" kind="mermaid" [context]="snippetContext()" /> }
              @default {
                <div class="board-md-code" dir="ltr"><div class="board-md-code-bar"><span>{{ b.lang }}{{ b.info ? ' ' + b.info : '' }}</span></div>
                  <pre class="board-md-pre" dir="ltr">{{ b.text }}</pre></div>
              }
            }
          }
          @case ('progress') {
            <div class="board-progress" [attr.dir]="dir() === 'auto' ? 'auto' : dir()">
              <div class="board-progress-track"><i [style.width.%]="pct(b)"></i></div>
              <span class="board-progress-n">{{ b.value }} / {{ b.max }}</span>@if (b.label) { <span class="board-progress-l">{{ b.label }}</span> }
            </div>
          }
          @case ('tabs') {
            <div class="board-tabs">
              <div class="board-tabs-head" role="tablist">
                @for (t of b.tabs; track $index; let ti = $index) {
                  <button type="button" role="tab" class="board-tab" [class.on]="tabOf(path + '/' + bi) === ti" [attr.aria-selected]="tabOf(path + '/' + bi) === ti"
                          (click)="setTab(path + '/' + bi, ti)">{{ t.title }}</button>
                }
              </div>
              @for (t of b.tabs; track $index; let ti = $index) {
                @if (tabOf(path + '/' + bi) === ti) {
                  <div class="board-tab-body" role="tabpanel"><ng-container *ngTemplateOutlet="blk; context: { $implicit: t.blocks, path: path + '/' + bi + 't' + ti }" /></div>
                }
              }
            </div>
          }
          @case ('choices') {
            <div class="board-choices">@for (o of b.options; track $index) { <button type="button" class="board-choice" disabled title="Answering from here comes with the interactive blocks">{{ o }}</button> }</div>
          }
          @case ('actions') {
            <div class="board-actions">@for (a of b.items; track $index) { <span class="board-action-chip">▸ {{ a.label }}</span> }</div>
          }
          @case ('callview') { <div class="board-md-callrow"><app-call-mini [mention]="b.ref" /></div> }
          @case ('table') {
            <div class="board-md-table-wrap" [class.scroll]="!wrap()"><table class="board-md-table" [attr.dir]="dirOfAll(b.header)">
              <thead><tr>@for (c of b.header; track $index) { <th [attr.dir]="dirOf(c)"><ng-container *ngTemplateOutlet="inl; context: { $implicit: c }" /></th> }</tr></thead>
              <tbody>
                @for (row of b.rows; track $index) {
                  <tr>@for (c of row; track $index) { <td [attr.dir]="dirOf(c)"><ng-container *ngTemplateOutlet="inl; context: { $implicit: c }" /></td> }</tr>
                }
              </tbody>
            </table></div>
          }
        }
      }
    </ng-template>
    <div class="board-md">
      @if (outline() && headings().length >= 3) {
        <nav class="board-md-outline" aria-label="Outline">
          @for (h of headings(); track $index) {
            <button type="button" class="board-md-outline-item" [style.padding-inline-start.rem]="(h.level - 1) * 0.6" (click)="jump(h.slug)">{{ h.text }}</button>
          }
        </nav>
      }
      @for (s of sections(); track $index; let si = $index) {
      <div class="board-md-section" [class.board-md-callout]="s.callout">
        <ng-container *ngTemplateOutlet="blk; context: { $implicit: s.blocks, path: 's' + si }" />
      </div>
      }
      @if (!blocks().length && empty()) { <p class="board-dim">{{ empty() }}</p> }
    </div>
    @if (zoom(); as z) {
      <div class="board-md-zoom" (click)="zoom.set(null)"><img [src]="z" alt="" /></div>
    }`,
})
export class MarkdownViewComponent {
  readonly text = input<string | null>('');
  readonly empty = input('');
  readonly previews = input(true);
  /** Prefixed to heading ids so two views on one page cannot clash. */
  readonly idPrefix = input('md-');
  /**
   * Which way it reads: auto (the default) gives each paragraph, item, heading and cell its own direction from its
   * words - Arabic right-to-left, English left-to-right, mixed by the language most of it is in; or one forced (the ⇄
   * switch). Code always reads left-to-right; code and mentions inside a sentence are isolated so they keep their order.
   */
  readonly dir = input<DirChoice>('auto');
  /** A long text (description, brief, spec file) with three headings or more gets an outline above it. */
  readonly outline = input(false);
  /** A spec file's name: its headings get "copy a link" (a spec mention to that section). */
  readonly specFile = input<string | null>(null);
  readonly cycleId = input<string | null>(null);
  /** Where this text lives (card, cycle, comment), passed to a snippet as `alfred.context`. */
  readonly snippetContext = input<Record<string, unknown>>({});

  readonly blocks = computed(() => textBlocks(this.text()));
  /** The blocks split at each heading; a section headed "Next" is a callout - the one thing to do. */
  readonly sections = computed(() => markdownSections(this.blocks()));
  readonly headings = computed(() => headingsOf(this.blocks()));
  readonly copied = signal<string | null>(null);
  readonly numbered = signal<ReadonlySet<string>>(new Set());
  /** Code blocks the reader switched away from the text's mode (wrap ↔ scroll). */
  readonly flipped = signal<ReadonlySet<string>>(new Set());
  /** Long lines wrap (true) or keep whole and scroll sideways inside their table or code block (false, the default). */
  readonly wrap = input(false);
  readonly zoom = signal<string | null>(null);
  /** The open tab of each tabs block (by its place in the text). */
  private readonly tabs = signal<Readonly<Record<string, number>>>({});

  tabOf(key: string): number {
    return this.tabs()[key] ?? 0;
  }

  setTab(key: string, i: number): void {
    this.tabs.update((t) => ({ ...t, [key]: i }));
  }

  pct(b: Block): number {
    return b.kind === 'progress' ? Math.max(0, Math.min(100, (100 * b.value) / (b.max || 1))) : 0;
  }

  dirOf(nodes: readonly Inline[]): string {
    return blockDir(this.dir(), inlineWords(nodes));
  }

  /** A list's or table's own direction (where its bullets and columns go): from all of its words. */
  dirOfAll(rows: readonly (readonly Inline[])[]): string {
    return blockDir(this.dir(), rows.map(inlineWords).join(' '));
  }

  dirOfBlocks(title: readonly Inline[], blocks: readonly Block[]): string {
    return blockDir(this.dir(), [inlineWords(title), ...blocks.map(wordsOfBlock)].join(' '));
  }

  /** A paragraph that is one call mention and nothing else shows as a call card. */
  callCard(b: Block): import('../../../core/models/board.models').MentionRef | null {
    if (b.kind !== 'paragraph') return null;
    const real = b.inlines.filter((n) => !(n.kind === 'text' && !n.text.trim()) && n.kind !== 'br');
    return real.length === 1 && real[0].kind === 'mention' && real[0].ref.type.toLowerCase() === 'call' ? real[0].ref : null;
  }

  codeTokens(b: Block): readonly import('../../../shared/utils/code-highlight').CodeToken[] | null {
    return b.kind === 'code' ? b.tokens ?? b.json ?? null : null;
  }

  /** Tokens split at line ends, so each line can carry its number. */
  linesOf(tokens: readonly import('../../../shared/utils/code-highlight').CodeToken[]): { text: string; kind: string | null }[][] {
    const out: { text: string; kind: string | null }[][] = [[]];
    for (const t of tokens) {
      const parts = t.text.split('\n');
      parts.forEach((p, i) => {
        if (i > 0) { out[out.length - 1].push({ text: '\n', kind: null }); out.push([]); }
        if (p) out[out.length - 1].push({ text: p, kind: t.kind });
      });
    }
    return out;
  }

  lineCount(text: string): number {
    return text.split('\n').length;
  }

  langLabel(lang: string): string {
    const l = langOf(lang);
    return CODE_LANGS.find((x) => x.id === l)?.label ?? (lang || 'Text');
  }

  calloutIcon(tone: string): string {
    return ({ info: 'ℹ', warn: '⚠', bug: '✕', ok: '✓', next: '→' } as Record<string, string>)[tone] ?? 'ℹ';
  }

  calloutTitle(tone: string): string {
    return (CALLOUT_TITLES as Record<string, string>)[tone] ?? '';
  }

  /** Pictures are Alfred's own (/board/images/...), served from the backend's address. */
  imageSrc(src: string): string {
    const base = (typeof window !== 'undefined' && (window as unknown as { BACKEND_URL?: string }).BACKEND_URL) || '';
    return base + src;
  }

  wraps(key: string): boolean {
    return this.wrap() !== this.flipped().has(key);
  }

  toggle(set: typeof this.numbered, key: string): void {
    set.update((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  copyCode(key: string, text: string): void {
    void copyToClipboard(text).then(() => this.flash(key));
  }

  copyHeading(b: Block): void {
    if (b.kind !== 'heading' || !this.specFile() || !this.cycleId()) return;
    const label = `${this.specFile()} §${inlineWords(b.inlines).trim()}`.replace(/[|\]\n]/g, ' ');
    void copyToClipboard(`@[spec:${this.cycleId()}/${this.specFile()}#${b.slug}|${label}]`).then(() => this.flash(b.slug));
  }

  jump(slugOf: string): void {
    document.getElementById(this.idPrefix() + slugOf)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  private flash(key: string): void {
    this.copied.set(key);
    setTimeout(() => this.copied.set(null), 1500);
  }

  asInlines(nodes: unknown): readonly Inline[] {
    return nodes as readonly Inline[];
  }

  asBlocks(nodes: unknown): readonly Block[] {
    return nodes as readonly Block[];
  }

  kids(n: Inline): readonly Inline[] {
    return 'children' in n ? n.children : [];
  }

  hrefOf(n: Inline): string {
    return n.kind === 'link' ? n.href : '';
  }

  refOf(n: Inline): import('../../../core/models/board.models').MentionRef {
    return (n as Extract<Inline, { kind: 'mention' }>).ref;
  }

  varOf(n: Inline): string {
    return n.kind === 'variable' ? n.name : '';
  }

  colorOf(n: Inline): string {
    return n.kind === 'color' ? n.color : '';
  }

  toneOf(n: Inline): string {
    return n.kind === 'pill' ? n.tone : '';
  }

  textOf(n: Inline): string {
    return n.kind === 'pill' ? n.text : '';
  }

  pillIcon(n: Inline): string {
    return n.kind === 'pill' ? ({ ok: '✓', fail: '✕', wait: '⏳', info: 'ℹ' } as Record<string, string>)[n.tone] ?? '' : '';
  }
}

function wordsOfBlock(b: Block): string {
  switch (b.kind) {
    case 'heading': case 'paragraph': case 'quote': return inlineWords(b.inlines);
    case 'list': return b.items.map(inlineWords).join(' ');
    case 'callout': return [inlineWords(b.title), ...b.blocks.map(wordsOfBlock)].join(' ');
    case 'fold': return [inlineWords(b.summary), ...b.blocks.map(wordsOfBlock)].join(' ');
    case 'table': return [b.header, ...b.rows].map((r) => r.map(inlineWords).join(' ')).join(' ');
    case 'tabs': return b.tabs.map((t) => [t.title, ...t.blocks.map(wordsOfBlock)].join(' ')).join(' ');
    default: return ' ';
  }
}
