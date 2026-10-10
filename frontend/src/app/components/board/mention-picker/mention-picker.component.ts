import { Component, ElementRef, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { forkJoin, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { MENTION_ICONS, MentionRef, MentionType } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { CallLogsApiService } from '../../../core/services/call-logs-api.service';
import { DbCaptureApiService } from '../../../core/services/db-capture-api.service';
import { InterceptionApiService } from '../../../core/services/interception-api.service';
import { SessionCyclesApiService } from '../../../core/services/session-cycles-api.service';
import { CallFinderComponent, FoundCall } from '../../call-finder/call-finder.component';
import { callOf, slug } from '../../../shared/utils/mention-syntax';

type Tab = 'call' | 'stmt' | 'log' | 'redis' | 'spec' | 'code' | 'other';

interface Option {
  readonly ref: MentionRef;
  readonly detail: string;
}

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'call', label: `${MENTION_ICONS.call} Calls` },
  { id: 'stmt', label: `${MENTION_ICONS.stmt} Statements` },
  { id: 'log', label: `${MENTION_ICONS.log} Logs` },
  { id: 'redis', label: `${MENTION_ICONS.redis} Redis` },
  { id: 'spec', label: `${MENTION_ICONS.spec} Spec files` },
  { id: 'code', label: `${MENTION_ICONS.code} Code` },
  { id: 'other', label: `${MENTION_ICONS.cycle} Cycles · spacers · cards · rules` },
];

/**
 * The `@` picker (FR-022): one tab per kind of thing, a search, arrow keys / Enter / Tab / Esc. The Calls tab is the
 * app's own call finder (reused whole - its search and paging are its own), where a row click is the pick. Statements, log lines and Redis commands
 * are picked from a call the text already mentions (they belong to a call).
 */
@Component({
  selector: 'app-mention-picker',
  standalone: true,
  imports: [CallFinderComponent],
  template: `
    <div class="board-picker" (keydown)="onKey($event)">
      <div class="board-picker-tabs" role="tablist">
        @for (t of tabs; track t.id) {
          <button type="button" role="tab" [class.on]="tab() === t.id" (click)="setTab(t.id)">{{ t.label }}</button>
        }
        <button type="button" class="board-picker-close" title="Close (Esc)" (click)="closed.emit()">✕</button>
      </div>
      @if (tab() === 'call') {
        <div class="board-picker-finder">
          <app-call-finder [initialDirection]="'inbound'" pickLabel="Mention this call" [pickOnClick]="true" [allowPickAnywhere]="canPickAnywhere()"
                           (chosen)="pickCall($event)" (pickAnywhere)="pickFromAnywhere()" />
        </div>
      } @else if (tab() === 'code') {
        <div class="board-picker-code">
          <input #code type="text" placeholder="src/main/java/OrderMapper.java:142" (keydown.enter)="pickCode(code.value)" />
          <button type="button" class="action-btn primary" (click)="pickCode(code.value)">Mention</button>
        </div>
      } @else {
        @if (needsCall()) {
          <div class="board-picker-calls">
            @if (!calls().length) { <span class="board-dim">Mention a call first - its statements, log lines and Redis commands appear here.</span> }
            @for (c of calls(); track c.ref) {
              <button type="button" [class.on]="callForTab() === c.ref" (click)="callForTab.set(c.ref)">{{ c.label }}</button>
            }
          </div>
        }
        <input #search class="board-picker-search" type="text" placeholder="Search…  (↑↓ move, Enter insert, Tab next type)"
               [value]="query()" (input)="query.set(search.value); highlighted.set(0)" />
        <div class="board-picker-list">
          @if (loading()) { <div class="board-dim">Loading…</div> }
          @for (o of shown(); track o.ref.type + o.ref.ref; let i = $index) {
            <button type="button" class="board-picker-item" [class.hl]="i === highlighted()" (click)="pick(o.ref)">
              <span class="board-picker-label">{{ o.ref.label }}</span><span class="board-dim">{{ o.detail }}</span>
            </button>
          } @empty {
            @if (!loading()) { <div class="board-dim">Nothing to mention here.</div> }
          }
        </div>
      }
    </div>`,
})
export class MentionPickerComponent {
  private readonly board = inject(BoardApiService);
  private readonly db = inject(DbCaptureApiService);
  private readonly logs = inject(CallLogsApiService);
  private readonly cycles = inject(SessionCyclesApiService);
  private readonly rules = inject(InterceptionApiService);

  readonly project = input('');
  readonly cycleId = input<string | null>(null);
  /** Call mentions already in the text or on the card - the calls whose statements, lines and commands can be picked. */
  readonly calls = input<readonly MentionRef[]>([]);
  /** Offer "Pick from anywhere" (Live Calls and every cycle, with the pick bar) - the host says where the picks go. */
  readonly canPickAnywhere = input(false);
  /** "Pick from anywhere" was pressed: the host starts the pick, since only it knows whether the picks are text or links. */
  readonly pickAnywhere = output<void>();
  readonly picked = output<MentionRef>();
  readonly closed = output<void>();

  readonly tabs = TABS;
  readonly tab = signal<Tab>('call');
  readonly query = signal('');
  readonly highlighted = signal(0);
  readonly loading = signal(false);
  readonly options = signal<readonly Option[]>([]);
  readonly callForTab = signal<string | null>(null);
  private readonly searchBox = viewChild<ElementRef<HTMLInputElement>>('search');

  readonly needsCall = computed(() => this.tab() === 'stmt' || this.tab() === 'log' || this.tab() === 'redis');
  readonly shown = computed(() => {
    const q = this.query().trim().toLowerCase();
    const all = this.options();
    return (q ? all.filter((o) => `${o.ref.label} ${o.detail}`.toLowerCase().includes(q)) : all).slice(0, 200);
  });

  constructor() {
    effect(() => {
      const tab = this.tab();
      const callRef = this.callForTab();
      untracked(() => this.loadOptions(tab, callRef));
    });
    effect(() => {
      const calls = this.calls();
      untracked(() => {
        if (!this.callForTab() && calls.length) this.callForTab.set(calls[0].ref);
      });
    });
  }

  setTab(tab: Tab): void {
    this.tab.set(tab);
    this.query.set('');
    this.highlighted.set(0);
    queueMicrotask(() => this.searchBox()?.nativeElement.focus());
  }

  onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closed.emit();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const i = TABS.findIndex((t) => t.id === this.tab());
      this.setTab(TABS[(i + (event.shiftKey ? TABS.length - 1 : 1)) % TABS.length].id);
    } else if (event.key === 'ArrowDown' && this.tab() !== 'call') {
      event.preventDefault();
      this.highlighted.update((h) => Math.min(h + 1, Math.max(0, this.shown().length - 1)));
    } else if (event.key === 'ArrowUp' && this.tab() !== 'call') {
      event.preventDefault();
      this.highlighted.update((h) => Math.max(0, h - 1));
    } else if (event.key === 'Enter' && this.tab() !== 'call' && this.tab() !== 'code') {
      event.preventDefault();
      const o = this.shown()[this.highlighted()];
      if (o) this.pick(o.ref);
    }
  }

  pick(ref: MentionRef): void {
    this.picked.emit(ref);
  }

  pickCall(found: FoundCall): void {
    const c = found.call;
    let path = c.url;
    try {
      path = new URL(c.url).pathname;
    } catch {
      // a relative url is already a path
    }
    const status = c.response?.status ?? (c.error ? 'error' : '…');
    this.pick({ type: 'call', ref: `${found.direction === 'outbound' ? 'out' : 'in'}:${c.id}`, label: `${c.method} ${path} · ${status}` });
  }

  pickFromAnywhere(): void {
    this.pickAnywhere.emit();
  }

  pickCode(value: string): void {
    const v = value.trim();
    if (!v) return;
    const name = v.split(/[\\/]/).pop() ?? v;
    this.pick({ type: 'code', ref: v, label: name });
  }

  private loadOptions(tab: Tab, callRef: string | null): void {
    this.options.set([]);
    if (tab === 'call' || tab === 'code') return;
    const call = callRef ? callOf({ type: 'call', ref: callRef, label: '' }) : null;
    if ((tab === 'stmt' || tab === 'log' || tab === 'redis') && !call) return;
    this.loading.set(true);
    const done = (options: readonly Option[]) => {
      this.options.set(options);
      this.loading.set(false);
    };
    const fail = () => {
      this.loading.set(false);
      return of([] as Option[]);
    };
    if (tab === 'stmt' && call) {
      this.db.statements(call.id).pipe(map((page) => page.statements.map((s) => ({
        ref: { type: 'stmt' as MentionType, ref: `${call.id}/${s.seq}`, label: `${s.kind} ${s.table ?? ''} #${s.seq}`.replace(/\s+/g, ' ') },
        detail: s.sql.slice(0, 120),
      }))), catchError(fail)).subscribe(done);
    } else if (tab === 'log' && call) {
      this.logs.allLines(call.id, call.cycleId).pipe(map((lines) => lines.map((l) => ({
        ref: { type: 'log' as MentionType, ref: `${call.id}/${l.lineId}`, label: `${l.level ?? ''} ${(l.logger ?? '').split('.').pop()}`.trim() || 'log line' },
        detail: l.message.slice(0, 120),
      }))), catchError(fail)).subscribe(done);
    } else if (tab === 'redis' && call) {
      this.db.storeCommands(call.id).pipe(map((page) => page.commands.map((c) => ({
        ref: { type: 'redis' as MentionType, ref: `${call.id}/${c.seq}`, label: `${c.command} ${c.keys[0] ?? ''}`.trim() },
        detail: `#${c.seq}`,
      }))), catchError(fail)).subscribe(done);
    } else if (tab === 'spec') {
      const cycleId = this.cycleId();
      if (!cycleId) {
        done([]);
        return;
      }
      this.board.specs(cycleId).pipe(catchError(() => of([]))).subscribe((files) => {
        if (!files.length) {
          done([]);
          return;
        }
        forkJoin(files.map((f) => this.board.spec(cycleId, f.name).pipe(catchError(() => of('')), map((text) => ({ f, text })))))
          .subscribe((all) => done(all.flatMap(({ f, text }) => [
            { ref: { type: 'spec' as MentionType, ref: `${cycleId}/${f.name}`, label: f.name }, detail: 'whole file' },
            ...text.split(/\r?\n/).filter((l) => /^#{1,6}\s/.test(l.trim())).map((l) => {
              const heading = l.trim().replace(/^#{1,6}\s+/, '');
              return { ref: { type: 'spec' as MentionType, ref: `${cycleId}/${f.name}#${slug(heading)}`, label: `${f.name} §${heading}` }, detail: 'section' };
            }),
          ])));
      });
    } else {
      const cycleId = this.cycleId();
      forkJoin({
        cycles: this.cycles.list().pipe(catchError(() => of([]))),
        spacers: cycleId ? this.cycles.listSpacers(cycleId).pipe(catchError(() => of([]))) : of([]),
        cards: this.board.cards(this.project(), null, { kinds: [], flags: [], author: null, scopeNotDecided: false, q: '' }).pipe(
          map((p) => p.cards), catchError(() => of([]))),
        rules: this.rules.listRules().pipe(catchError(() => of([]))),
      }).subscribe(({ cycles, spacers, cards, rules }) => done([
        ...cards.map((c) => ({ ref: { type: 'card' as MentionType, ref: `${c.project}#${c.number}`, label: c.title }, detail: `card #${c.number}` })),
        ...cycles.map((c) => ({ ref: { type: 'cycle' as MentionType, ref: c.id, label: c.name }, detail: 'cycle' })),
        ...spacers.map((s) => ({ ref: { type: 'spacer' as MentionType, ref: `${cycleId}/${s.id}`, label: s.label }, detail: 'spacer' })),
        ...rules.map((r) => ({ ref: { type: 'rule' as MentionType, ref: r.id, label: r.name }, detail: 'rule' })),
      ]));
    }
  }
}
