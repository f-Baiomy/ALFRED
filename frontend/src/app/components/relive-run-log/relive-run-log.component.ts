import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, input, output, signal } from '@angular/core';
import { LogEntry, Step } from '../../shared/utils/relive-types';
import { RunLogRow, RunLogTag, buildRunLog, runLogOffset, runLogTime } from '../../shared/utils/relive-run-log';

type LogFilter = 'all' | RunLogTag;

const FILTERS: readonly { readonly key: LogFilter; readonly label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'problem', label: 'Problems' },
  { key: 'rule', label: 'Rules' },
  { key: 'var', label: 'Variables' },
  { key: 'hold', label: 'Holds' },
];

/** The run's execution log (FR-038), one row per step attempt - see `buildRunLog`. Messages arrive
 *  already masked by the timeline (secret variables, FR-022a). */
@Component({
  selector: 'app-relive-run-log',
  standalone: true,
  imports: [NgTemplateOutlet],
  templateUrl: './relive-run-log.component.html',
})
export class ReliveRunLogComponent {
  readonly log = input<readonly LogEntry[]>([]);
  readonly steps = input<readonly Step[]>([]);
  readonly startedAt = input<string | null>(null);
  readonly selectStep = output<string>();

  readonly filters = FILTERS;
  readonly filter = signal<LogFilter>('all');
  readonly query = signal('');
  readonly newestFirst = signal(false);
  readonly openIds = signal<ReadonlySet<string>>(new Set());

  readonly rows = computed(() => buildRunLog(this.log(), this.steps()));

  readonly counts = computed(() => {
    const counts: Record<LogFilter, number> = { all: 0, problem: 0, rule: 0, var: 0, hold: 0 };
    for (const row of this.rows()) {
      counts.all++;
      for (const tag of row.tags) counts[tag]++;
    }
    return counts;
  });

  readonly outcomes = computed(() => {
    const all = this.rows().flatMap((row) => [row, ...row.children]);
    return {
      ok: all.filter((r) => r.outcome?.kind === 'ok').length,
      diff: all.filter((r) => r.outcome?.kind === 'diff').length,
      fail: all.filter((r) => r.outcome?.kind === 'fail').length,
    };
  });

  readonly shown = computed(() => {
    const filter = this.filter();
    const query = this.query().trim().toLowerCase();
    const rows = this.rows().filter((row) => (filter === 'all' || row.tags.includes(filter)) && (!query || matches(row, query)));
    return this.newestFirst() ? [...rows].reverse() : rows;
  });

  readonly allOpen = computed(() => {
    const expandable = this.rows().flatMap((row) => [row, ...row.children]).filter((r) => r.events.length);
    return expandable.length > 0 && expandable.every((r) => this.openIds().has(r.id));
  });

  private readonly startMs = computed(() => {
    const started = this.startedAt();
    return started ? Date.parse(started) : (this.rows()[0]?.atMs ?? NaN);
  });

  time(row: RunLogRow): string {
    return runLogTime(row.at);
  }

  offset(row: RunLogRow): string {
    return runLogOffset(row.atMs, this.startMs());
  }

  isOpen(row: RunLogRow): boolean {
    return this.openIds().has(row.id);
  }

  toggle(row: RunLogRow): void {
    if (!row.events.length) return;
    const next = new Set(this.openIds());
    if (next.has(row.id)) next.delete(row.id);
    else next.add(row.id);
    this.openIds.set(next);
  }

  toggleAll(): void {
    this.openIds.set(
      this.allOpen()
        ? new Set()
        : new Set(this.rows().flatMap((row) => [row, ...row.children]).filter((r) => r.events.length).map((r) => r.id))
    );
  }

  /** A step named after its own call ("GET /app/users", the default label) would only repeat the path. */
  showsLabel(row: RunLogRow): boolean {
    const label = row.stepLabel?.trim();
    if (!label) return false;
    const slash = row.target.indexOf('/');
    const path = row.url && slash >= 0 ? row.target.slice(slash).split('?')[0] : '';
    return !(path.length > 1 && label.includes(path));
  }

  answeredClass(row: RunLogRow): string {
    return row.answeredBy === 'LIVE' ? 'rl-p-live' : row.answeredBy === 'BLOCKED' ? 'rl-p-fail' : 'rl-p-replay';
  }

  statusClass(status: number): string {
    return status >= 500 ? 'rl-log-s5' : status >= 400 ? 'rl-log-s4' : 'rl-log-s2';
  }

  rowClass(row: RunLogRow): string {
    const kind = row.outcome?.kind;
    return kind === 'fail' ? 'rl-log-problem' : kind === 'diff' || kind === 'warn' ? 'rl-log-warn' : '';
  }

  onSearch(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }
}

function matches(row: RunLogRow, query: string): boolean {
  const text = [
    row.target,
    row.url ?? '',
    row.stepLabel ?? '',
    ...row.events.map((e) => `${e.label} ${e.text}`),
    ...row.children.flatMap((c) => [c.target, c.stepLabel ?? '', ...c.events.map((e) => e.text)]),
  ];
  return text.join(' ').toLowerCase().includes(query);
}
