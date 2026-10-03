import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { LineStructure, LineStructures, LogStructure } from '../../core/models/logs.model';
import { LogsApiService } from '../../core/services/logs-api.service';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { templateTokens } from '../../shared/utils/logs-template';

interface Draft {
  readonly name: string;
  readonly template: string;
}

/**
 * The structures found among a source's lines (each line may have its own structure): name, share of
 * lines, fields, an optional summary template of their own, and "move to its own source".
 */
@Component({
  selector: 'app-log-line-structures',
  standalone: true,
  imports: [FormsModule, DecimalPipe],
  template: `
    <div class="lg-card" style="padding: 14px 16px; margin-top: 12px">
      <div class="lg-row">
        <h3 class="lg-h3" style="margin: 0">Line structures</h3>
        <span class="lg-dim">{{ data().structures.length }} found in {{ data().totalLines | number }} lines</span>
        @if (data().pending) { <span class="lg-pill live">sorting older lines…</span> }
        <span class="lg-sp"></span>
        <span class="lg-hint">Lines whose fields are mostly the same form one structure. All of them stay in this source.</span>
      </div>
      @for (st of data().structures; track st.id) {
        <div class="lg-struct">
          <div class="lg-row" style="flex-wrap: wrap">
            <span class="lg-badge">{{ st.code }}</span>
            <input type="text" style="width: 220px" [ngModel]="draft(st).name" (ngModelChange)="edit(st, { name: $event })"
                   [placeholder]="st.named ? '' : st.name" [attr.aria-label]="'Name of ' + st.code" />
            <span class="lg-dim">{{ st.lineCount | number }} lines · {{ share(st) }}</span>
            <button class="lg-link" (click)="toggle(st.id)">{{ st.fields.length }} fields {{ open() === st.id ? '▴' : '▾' }}</button>
            <span class="lg-sp"></span>
            @if (dirty(st)) {
              <button class="lg-btn xs primary" (click)="save(st)">Save</button>
            }
            @if (canMove()) {
              <button class="lg-btn xs" (click)="move(st)" title="Load these lines into a new source and remove them here">Move to own source</button>
            }
          </div>
          <div class="lg-row" style="margin-top: 6px">
            <span class="lg-dim" style="width: 120px">Summary template</span>
            <input type="text" class="lg-mono" style="flex: 1" [ngModel]="draft(st).template" (ngModelChange)="edit(st, { template: $event })"
                   [placeholder]="'Source template: ' + (structure().template || '(empty)')" [attr.aria-label]="'Summary template of ' + st.code" />
          </div>
          @if (unknown(st).length) { <div class="lg-error-text">Unknown fields: {{ unknown(st).join(', ') }}</div> }
          @if (open() === st.id) {
            <div class="lg-mono lg-dim" style="margin-top: 6px; font-size: 11.5px">{{ st.fields.join(' · ') }}</div>
          }
          @if (message()[st.id]; as m) { <div class="lg-hint">{{ m }}</div> }
        </div>
      } @empty {
        <div class="lg-hint" style="margin-top: 8px">No lines yet.</div>
      }
    </div>
  `,
})
export class LogLineStructuresComponent {
  private readonly api = inject(LogsApiService);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly router = inject(Router);

  readonly sourceId = input.required<string>();
  readonly sourceName = input('');
  readonly data = input.required<LineStructures>();
  readonly structure = input.required<LogStructure>();
  /** Moving needs the raw lines stored in ALFRED. */
  readonly canMove = input(false);
  readonly changed = output<void>();

  readonly open = signal<number | null>(null);
  readonly message = signal<Record<number, string>>({});
  private readonly drafts = signal<Record<number, Draft>>({});
  private readonly labels = computed(() => new Set(this.structure().fields.map((f) => f.label)));

  draft(st: LineStructure): Draft {
    return this.drafts()[st.id] ?? { name: st.named ? st.name : '', template: st.template };
  }

  edit(st: LineStructure, patch: Partial<Draft>): void {
    this.drafts.update((d) => ({ ...d, [st.id]: { ...this.draft(st), ...patch } }));
  }

  dirty(st: LineStructure): boolean {
    const d = this.drafts()[st.id];
    return !!d && (d.name !== (st.named ? st.name : '') || d.template !== st.template);
  }

  unknown(st: LineStructure): string[] {
    return templateTokens(this.draft(st).template).filter((t) => !this.labels().has(t));
  }

  share(st: LineStructure): string {
    const t = this.data().totalLines;
    const p = t ? st.lineCount / t : 0;
    return p > 0 && p < 0.01 ? '<1%' : `${Math.round(p * 100)}%`;
  }

  toggle(id: number): void {
    this.open.update((o) => (o === id ? null : id));
  }

  save(st: LineStructure): void {
    const d = this.draft(st);
    this.api.updateLineStructure(this.sourceId(), st.id, d.name, d.template).subscribe({
      next: () => {
        this.drafts.update((all) => {
          const { [st.id]: _, ...rest } = all;
          return rest;
        });
        this.note(st.id, 'Saved');
        this.changed.emit();
      },
      error: (e) => this.note(st.id, (e as { error?: { error?: string } })?.error?.error || 'Could not save'),
    });
  }

  async move(st: LineStructure): Promise<void> {
    const name = `${this.sourceName()} - ${st.named ? st.name : st.code}`.slice(0, 80);
    const ok = await this.confirm.confirm(
      `Move the ${st.lineCount.toLocaleString()} lines of ${st.code} (${st.name}) into a new source "${name}"? ` +
        'They are removed from this source; commented and pinned lines stay here.',
      'Move lines',
    );
    if (!ok) return;
    this.api.moveLineStructure(this.sourceId(), st.id, name).subscribe({
      next: (v) => void this.router.navigate(['/logs', v.source.id]),
      error: (e) => this.note(st.id, (e as { error?: { error?: string } })?.error?.error || 'Could not move the lines'),
    });
  }

  private note(id: number, text: string): void {
    this.message.update((m) => ({ ...m, [id]: text }));
  }
}
