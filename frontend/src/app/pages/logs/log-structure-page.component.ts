import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { LogsApiService } from '../../core/services/logs-api.service';
import { LogsSocketService } from '../../core/services/logs-socket.service';
import { LogStructureEditorComponent } from '../../components/logs/log-structure-editor.component';
import { LogLineStructuresComponent } from '../../components/logs/log-line-structures.component';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { LineStructures, LogLineSummary, LogStructure, RawMode } from '../../core/models/logs.model';

type StructureTab = 'fields' | 'levels' | 'template' | 'structures';
const TAB_KEY = 'alfred.logs.structureTab';

function readTab(): StructureTab {
  try {
    const t = sessionStorage.getItem(TAB_KEY);
    return t === 'levels' || t === 'template' || t === 'structures' ? t : 'fields';
  } catch {
    return 'fields';
  }
}

/** Structure editor for an existing source (/logs/:id/structure): changes rebuild in the background (FR-012). */
@Component({
  selector: 'app-log-structure-page',
  standalone: true,
  imports: [RouterLink, LogStructureEditorComponent, LogLineStructuresComponent, ConfirmDialogComponent],
  template: `
    <div class="lg-page">
      <div class="lg-row">
        <div>
          <h1 class="lg-h1">Structure · {{ name() }}</h1>
          <div class="lg-sub">Edit any time. Changing a type or search mode re-processes only that field, in the background.</div>
        </div>
        <span class="lg-sp"></span>
        <a class="lg-btn" [routerLink]="['/logs', id]">Cancel</a>
        <button class="lg-btn primary" [disabled]="saving() || !structure()" (click)="save()">{{ saving() ? 'Saving…' : 'Save structure' }}</button>
      </div>
      @if (error()) { <div class="lg-note lg-error-text">{{ error() }}</div> }
      @if (structure(); as s) {
        <div class="lg-tabs" role="tablist">
          <button role="tab" [class.on]="tab() === 'fields'" (click)="setTab('fields')">Fields<span class="n">{{ fieldCount() }}</span></button>
          <button role="tab" [class.on]="tab() === 'levels'" (click)="setTab('levels')">Grouping levels<span class="n">{{ s.groupLevels.length }}</span></button>
          <button role="tab" [class.on]="tab() === 'template'" (click)="setTab('template')">Summary line template</button>
          <button role="tab" [class.on]="tab() === 'structures'" (click)="setTab('structures')">Line structures<span class="n">{{ lineStructures()?.structures?.length ?? 0 }}</span></button>
        </div>
        @if (editorSection(); as sec) {
          <div style="margin-top: -1px">
            <app-log-structure-editor [structure]="s" (structureChange)="structure.set($event)" [rebuilding]="rebuilding()" [section]="sec"
                                      [sourceId]="id" [presence]="lineStructures()?.presence ?? null" (invalidClicked)="showInvalid($event)" />
          </div>
        } @else {
          @if (lineStructures(); as ls) {
            <app-log-line-structures [sourceId]="id" [sourceName]="name()" [data]="ls" [structure]="s" [canMove]="rawMode() === 'COPY'"
                                     (changed)="loadStructures()" />
          }
        }
      }
      @if (invalid(); as inv) {
        <div class="lg-overlay" (click)="invalid.set(null)">
          <div class="lg-card lg-dialog" (click)="$event.stopPropagation()">
            <div class="lg-row"><h2 class="lg-h2">Values of {{ inv.label }} that did not fit its type</h2><span class="lg-sp"></span>
              <button class="lg-btn sm" (click)="invalid.set(null)">Close</button></div>
            <div class="lg-hint" style="margin: 6px 0">Kept as their original text - shown here, searchable as text, never dropped. Latest {{ inv.rows.length }}.</div>
            @for (r of inv.rows; track r.lineId) {
              <div class="lg-kv" style="grid-template-columns: 200px minmax(0, 1fr)"><span class="lg-dim">{{ r.lineId }}</span><span class="v">{{ r.fields[inv.label] }}</span></div>
            } @empty {
              <div class="lg-dim">None.</div>
            }
          </div>
        </div>
      }
      <app-confirm-dialog />
    </div>
  `,
})
export class LogStructurePageComponent implements OnInit {
  private readonly api = inject(LogsApiService);
  private readonly socket = inject(LogsSocketService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  readonly id = inject(ActivatedRoute).snapshot.paramMap.get('id') ?? '';

  readonly structure = signal<LogStructure | null>(null);
  readonly name = signal('');
  readonly saving = signal(false);
  readonly error = signal('');
  readonly rebuilding = signal('');
  readonly lineStructures = signal<LineStructures | null>(null);
  readonly rawMode = signal<RawMode>('COPY');
  readonly tab = signal<StructureTab>(readTab());
  readonly editorSection = computed(() => {
    const t = this.tab();
    return t === 'structures' ? null : t;
  });
  readonly fieldCount = computed(() => (this.structure()?.fields ?? []).filter((f) => !f.duplicateOf).length);

  setTab(t: StructureTab): void {
    this.tab.set(t);
    try {
      sessionStorage.setItem(TAB_KEY, t);
    } catch {
      // The remembered tab is a convenience only.
    }
  }
  readonly invalid = signal<{ label: string; rows: LogLineSummary[] } | null>(null);

  showInvalid(label: string): void {
    this.api.invalidValues(this.id, label).subscribe((rows) => this.invalid.set({ label, rows }));
  }

  ngOnInit(): void {
    this.api.source(this.id).subscribe({
      next: (v) => {
        this.name.set(v.source.name);
        this.rawMode.set(v.source.rawMode);
      },
      error: () => this.error.set('Source not found'),
    });
    this.api.structure(this.id).subscribe((s) => this.structure.set(s));
    this.loadStructures();
    this.socket.events$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((e) => {
      if (e.type === 'structure-changed' && e.sourceId === this.id) {
        this.rebuilding.set(e.rebuilding ?? '');
        if (!e.rebuilding) this.loadStructures();
      }
    });
  }

  loadStructures(): void {
    this.api.structures(this.id).subscribe((ls) => this.lineStructures.set(ls));
  }

  save(): void {
    const s = this.structure();
    if (!s) return;
    this.saving.set(true);
    this.api.saveStructure(this.id, s).subscribe({
      next: () => void this.router.navigate(['/logs', this.id]),
      error: (e) => {
        this.saving.set(false);
        this.error.set((e as { error?: { error?: string } })?.error?.error || 'Could not save the structure');
      },
    });
  }
}
