import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { CHIP_LIMIT, DbFinding, FindingChip, fmtMs } from '../../shared/utils/db-findings';

const NOTES = 'notes';

/**
 * The call's findings (specs/006-db-capture/timeline-mock.html): one closed line each - icon, title, short why,
 * count, impact; opened, the full why, the fix and its statements as chips (click one to jump to it). Hovering a
 * finding or a chip lights its items up on the timeline. "Show" narrows the statement list to a finding's
 * statements; "Mark expected" silences a query shape for the project.
 */
@Component({
  standalone: true,
  selector: 'app-db-findings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet],
  template: `
    @if (folded() && rail()) {
      <!-- folded beside the statements: a thin rail, click to unfold -->
      <div class="dbf-rail" role="button" title="Show the findings" (click)="fold.emit()">
        <span class="chev">▶</span><span class="rail-t">Findings</span>
        @if (bad()) {<span class="cnt bad">{{ bad() }}</span>}
        @if (warn()) {<span class="cnt warn">{{ warn() }}</span>}
      </div>
    } @else {
    <div class="dbf" [class.folded]="folded()">
      <div class="dbf-tools">
        <span class="dbf-title" role="button" [attr.aria-expanded]="!folded()" (click)="fold.emit()" [title]="folded() ? 'Show the findings' : 'Hide the findings'">
          <span class="chev" [class.open]="!folded()">▶</span> Findings
          @if (folded()) {
            @if (bad()) {<span class="cnt bad">{{ bad() }} {{ bad() === 1 ? 'error' : 'errors' }}</span>}
            @if (warn()) {<span class="cnt warn">{{ warn() }} to fix</span>}
          }
        </span>
        @if (!folded()) {<a (click)="openAll()">Open all</a><a (click)="open.set(emptySet)">Close all</a>}
      </div>
      @if (!folded()) {
      @for (f of main(); track f.id) {
        <ng-container *ngTemplateOutlet="one; context: { $implicit: f }" />
      }
      @if (notes().length > 1) {
        <!-- notes on one line: what they are, open for each -->
        <div class="dbf-f note dbf-notes" [class.on]="open().has(NOTES)">
          <div class="dbf-head" (click)="toggle(NOTES)" role="button" [attr.aria-expanded]="open().has(NOTES)">
            <span class="chev">▶</span><span class="ic">ⓘ</span><b>{{ notes().length }} notes</b>
            <span class="short">- {{ noteTitles() }}</span><span class="cnt"></span><span class="imp"></span>
          </div>
          @if (open().has(NOTES)) {
            <div class="dbf-notes-in">
              @for (f of notes(); track f.id) {
                <ng-container *ngTemplateOutlet="one; context: { $implicit: f }" />
              }
            </div>
          }
        </div>
      } @else {
        @for (f of notes(); track f.id) {
          <ng-container *ngTemplateOutlet="one; context: { $implicit: f }" />
        }
      }
      @if (!findings().length) {
        <div class="dimtxt dbf-none">Nothing to report - no errors, no slow, repeated or huge queries, no idle stretches.</div>
      }
      }
    </div>
    }
    <ng-template #one let-f>
        <div class="dbf-f" [class]="'dbf-f ' + f.severity" [class.on]="open().has(f.id)" [class.sel]="selected() === f.id"
             (mouseenter)="hover.emit(keysOf(f))" (mouseleave)="hover.emit(null)">
          <div class="dbf-head" (click)="toggle(f.id)" role="button" [attr.aria-expanded]="open().has(f.id)">
            <span class="chev">▶</span><span class="ic">{{ f.icon }}</span><b [title]="f.title">{{ f.title }}</b>
            <span class="short">- {{ f.short }}</span><span class="cnt">{{ f.count }}</span><span class="imp">{{ f.impact }}</span>
          </div>
          @if (open().has(f.id)) {
            <div class="dbf-open">
              <div class="why">{{ f.why }}</div>
              @if (f.fix) {<div class="fix">→ {{ f.fix }}</div>}
              @if (f.chips.length) {
                <div class="dbf-chips">
                  @for (c of f.chips; track c.key + c.n) {
                    <span class="dbf-chip" (click)="jump.emit(c.seq)" (mouseenter)="hoverChip($event, c)" (mouseleave)="hover.emit(keysOf(f))">
                      <i [class]="'k-' + c.kind"></i><span class="n">{{ c.n }}</span>{{ c.label }}@if (c.ms != null) {<span class="ms">{{ fmt(c.ms) }}</span>}
                    </span>
                  }
                  @if (f.chips.length >= chipLimit && f.seqs.length > f.chips.length) {<span class="dimtxt">and more - Show lists them all</span>}
                </div>
              }
              <div class="dbf-acts">
                @if (f.seqs.length > 1) {
                  <button type="button" class="action-btn" (click)="show.emit(f)">Show these {{ f.seqs.length }} in the tree</button>
                }
                @if (f.fingerprints.length && canMarkExpected()) {
                  @if (marked().has(f.id)) {<span class="dimtxt">✓ Marked as expected - not flagged again for this project.</span>}
                  @else {<button type="button" class="action-btn" (click)="mark(f)" title="This is intended - never flag these statements again for this project">Mark expected</button>}
                }
              </div>
            </div>
          }
        </div>
    </ng-template>
  `,
})
export class DbFindingsComponent {
  readonly findings = input.required<readonly DbFinding[]>();
  readonly canMarkExpected = input(false);
  /** The finding the statement list is narrowed to ("Show"). */
  readonly selected = input<string | null>(null);
  /** Folded: only the header (stacked) or a thin rail (side by side); `fold` asks the window to fold or unfold it. */
  readonly folded = input(false);
  readonly rail = input(false);
  readonly fold = output<void>();
  readonly bad = computed(() => this.findings().filter((f) => f.severity === 'bad').length);
  readonly warn = computed(() => this.findings().filter((f) => f.severity === 'warn').length);
  readonly jump = output<number>();
  readonly hover = output<ReadonlySet<string> | null>();
  readonly show = output<DbFinding>();
  readonly markExpected = output<DbFinding>();

  protected readonly fmt = fmtMs;
  protected readonly chipLimit = CHIP_LIMIT;
  protected readonly emptySet: ReadonlySet<string> = new Set();
  readonly open = signal<ReadonlySet<string>>(new Set());
  readonly marked = signal<ReadonlySet<string>>(new Set());
  readonly ids = computed(() => [...this.findings().map((f) => f.id), NOTES]);
  /** Errors and things to fix; the notes go on one line of their own when there are several. */
  readonly main = computed(() => this.findings().filter((f) => f.severity !== 'note'));
  readonly notes = computed(() => this.findings().filter((f) => f.severity === 'note'));
  readonly noteTitles = computed(() => this.notes().map((f) => f.title).join(' · '));
  protected readonly NOTES = NOTES;

  keysOf(f: DbFinding): ReadonlySet<string> {
    return new Set(f.keys);
  }

  hoverChip(event: MouseEvent, chip: FindingChip): void {
    event.stopPropagation();
    this.hover.emit(new Set([chip.key]));
  }

  toggle(id: string): void {
    const next = new Set(this.open());
    if (!next.delete(id)) next.add(id);
    this.open.set(next);
  }

  openAll(): void {
    this.open.set(new Set(this.ids()));
  }

  mark(f: DbFinding): void {
    this.marked.set(new Set(this.marked()).add(f.id));
    this.markExpected.emit(f);
  }
}
