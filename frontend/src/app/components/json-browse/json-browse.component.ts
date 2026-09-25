import { Component, computed, input, output, signal } from '@angular/core';
import { PathEntry, asText, jsonPathIndex, valuesAt } from '../../shared/utils/json-paths';

/** One ticked field, and what to do with it. */
export interface BrowsePick {
  readonly path: string;
  /** The field's value in the sample call - what a test compares with, or what an edit starts from. */
  readonly value: string;
  readonly as: 'test' | 'change';
  readonly type: PathEntry['type'];
}

function itemsLabel(n: number): string {
  return `[${n} item${n === 1 ? '' : 's'}]`;
}

interface Row {
  readonly entry: PathEntry;
  readonly key: string;
  readonly shown: string;
  readonly container: boolean;
}

/**
 * "Browse request / response body…": the sample call's body as an indented, colored tree. Each
 * field can be ticked, then marked "test it" (a condition with its current value) or "change it"
 * (Set JSON field, starting from its current value); "Add" hands the ticked ones to the editor.
 * Lists are shown once as `[*]`, so a tick means every item - the way a rule reads a list.
 */
@Component({
  selector: 'app-json-browse',
  standalone: true,
  template: `
    <div class="json-browse">
      <div class="jb-head">
        <b>{{ title() }}</b>
        <span class="muted">{{ allowChange() ? 'tick fields - each becomes a test or an edit, with its value from the call' : 'tick fields - each becomes a test, with its value from the call' }}</span>
        <span class="jb-spacer"></span>
        <button type="button" class="pill" (click)="closed.emit()">Close</button>
        <button type="button" class="pill on" [disabled]="!ticked().size" (click)="add()">Add {{ ticked().size || '' }}</button>
      </div>
      <div class="jb-tree" role="tree">
        @for (row of visible(); track row.entry.path) {
          <div class="jb-row" role="treeitem" [style.padding-left.rem]="row.entry.depth * 1.1" [class.on]="ticked().has(row.entry.path)">
            @if (row.container) {
              <button type="button" class="jb-fold" (click)="toggleFold(row.entry.path)" [attr.aria-expanded]="!folded().has(row.entry.path)">
                {{ folded().has(row.entry.path) ? '▸' : '▾' }}
              </button>
            } @else {
              <span class="jb-fold"></span>
            }
            <label class="jb-label">
              <input type="checkbox" [checked]="ticked().has(row.entry.path)" (change)="tick(row.entry.path, $any($event.target).checked)" />
              <span class="jb-key">{{ row.key }}</span>
              <span class="jb-value" [class]="'jb-' + row.entry.type">{{ row.shown }}</span>
            </label>
            @if (allowChange() && ticked().has(row.entry.path)) {
              <span class="jb-as">
                <button type="button" class="pill" [class.on]="modeOf(row.entry.path) === 'test'" (click)="setMode(row.entry.path, 'test')">test it</button>
                <button type="button" class="pill" [class.on]="modeOf(row.entry.path) === 'change'" (click)="setMode(row.entry.path, 'change')">change it</button>
              </span>
            }
          </div>
        } @empty {
          <p class="muted">The call's body is not JSON, so there are no fields to browse.</p>
        }
      </div>
    </div>
  `,
})
export class JsonBrowseComponent {
  readonly doc = input<unknown>(undefined);
  readonly title = input('Browse the body');
  /** False in a rule's match: its tests only test, so there is no "change it". */
  readonly allowChange = input(true);
  readonly picked = output<readonly BrowsePick[]>();
  readonly closed = output<void>();

  readonly ticked = signal<ReadonlyMap<string, 'test' | 'change'>>(new Map());
  readonly folded = signal<ReadonlySet<string>>(new Set());

  private readonly rows = computed<Row[]>(() =>
    jsonPathIndex(this.doc())
      // One reading of a list: its [*] form. [0] paths are for typing, not for browsing.
      .filter((e) => !/\[\d+\]/.test(e.path))
      .map((e) => {
        const key = e.path.split('.').pop() ?? e.path;
        const container = e.type === 'object' || e.type === 'list';
        const shown =
          e.type === 'list'
            ? itemsLabel((valuesAt(this.doc(), e.path)[0] as unknown[] | undefined)?.length ?? 0)
            : e.type === 'object'
              ? '{…}'
              : e.samples.slice(0, 3).map((s) => (e.type === 'text' ? `"${s}"` : s)).join(', ') + (e.count > 3 ? ' …' : '');
        return { entry: e, key, shown, container };
      })
  );

  readonly visible = computed(() => {
    const folded = [...this.folded()];
    return this.rows().filter((r) => !folded.some((f) => r.entry.path !== f && (r.entry.path.startsWith(f + '.') || r.entry.path.startsWith(f + '['))));
  });

  toggleFold(path: string): void {
    this.folded.update((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  tick(path: string, on: boolean): void {
    this.ticked.update((m) => {
      const next = new Map(m);
      if (on) next.set(path, next.get(path) ?? 'test');
      else next.delete(path);
      return next;
    });
  }

  modeOf(path: string): 'test' | 'change' {
    return this.ticked().get(path) ?? 'test';
  }

  setMode(path: string, mode: 'test' | 'change'): void {
    this.ticked.update((m) => new Map(m).set(path, mode));
  }

  add(): void {
    const doc = this.doc();
    const byPath = new Map(this.rows().map((r) => [r.entry.path, r.entry]));
    const picks: BrowsePick[] = [...this.ticked()].map(([path, as]) => {
      const entry = byPath.get(path)!;
      const values = valuesAt(doc, path);
      // A [*] path's first item stands for the rest; a list or object is compared as its JSON.
      const value = values.length ? asText(values[0]) : '';
      return { path, value, as, type: entry.type };
    });
    this.picked.emit(picks);
    this.ticked.set(new Map());
  }
}
