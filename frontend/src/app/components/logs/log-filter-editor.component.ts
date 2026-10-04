import { Component, ElementRef, afterNextRender, computed, effect, inject, Injector, input, output, signal, untracked, viewChild } from '@angular/core';
import { FieldDef, FieldValues, Pill } from '../../core/models/logs.model';
import { FilterCondition, FilterForm, formToPill, pillToForm } from '../../shared/utils/logs-filter';

/**
 * One filter as a small form (design B): Include / Exclude, Field (typed, with suggestions - any part of
 * the name), Condition, Value (the field's most common values to click; several = any of them).
 * Emits the pill; the explorer places it in the bar.
 */
@Component({
  selector: 'app-log-filter-editor',
  standalone: true,
  template: `
    <div class="lg-fed" (click)="$event.stopPropagation()" (keydown.escape)="cancel.emit()">
      <div class="lg-fed-h">{{ pill() ? 'Edit filter' : 'Add filter' }}</div>
      <div class="lg-fed-row">
        <label>Lines</label>
        <div class="lg-seg">
          <button [class.on]="include()" (click)="include.set(true)">Include</button>
          <button [class.on]="!include()" (click)="include.set(false)">Exclude</button>
        </div>
      </div>
      <div class="lg-fed-row">
        <label>Field</label>
        <div class="lg-fed-fw">
          <input #fieldIn type="text" autocomplete="off" placeholder="type a field name…" aria-label="Field"
                 [value]="field()" (input)="onField($any($event.target).value)" (focus)="suggestOpen.set(true)"
                 (blur)="closeSuggestSoon()" (keydown)="fieldKey($event)" />
          @if (suggestOpen() && suggestions().length) {
            <div class="lg-fed-fs">
              @for (f of suggestions(); track f.label; let i = $index) {
                <div [class.on]="i === sugIdx()" (mousedown)="$event.preventDefault(); pickField(f.label)">
                  <span class="ty">{{ icon(f) }}</span>
                  <span>@for (s of nameParts(f.label); track $index) {@if (s.hit) {<b>{{ s.text }}</b>} @else {{{ s.text }}}}</span>
                  <span class="cnt">{{ presenceText(f.label) }}</span>
                </div>
              }
            </div>
          }
        </div>
      </div>
      @if (fieldError()) { <div class="lg-fed-err">{{ fieldError() }}</div> }
      <div class="lg-fed-row">
        <label>Condition</label>
        <select [value]="condition()" (change)="setCondition($any($event.target).value)" aria-label="Condition">
          <option value="is">is</option>
          <option value="contains">contains</option>
          <option value="exists">exists (has any value)</option>
          <option value="gt">greater than</option>
          <option value="lt">less than</option>
        </select>
      </div>
      @if (condition() !== 'exists') {
        <div class="lg-fed-row">
          <label>Value</label>
          <input #valueIn type="text" aria-label="Value" [placeholder]="condition() === 'is' ? 'value - or click below; several = any of them' : 'value'"
                 [value]="condition() === 'is' ? valuesList().join(', ') : value()" (input)="onValue($any($event.target).value)" (keydown.enter)="apply()" />
        </div>
        @if (condition() === 'is' && top().length) {
          <div class="lg-fed-sugg">
            @for (t of top(); track t.value) {
              <button [class.on]="valuesList().includes(t.value)" (click)="toggleValue(t.value)" [title]="'Click to add or remove - several values = any of them'">{{ t.value }}<i>{{ t.count }}</i></button>
            }
          </div>
        }
      }
      @if (!field() && condition() === 'contains') { <div class="lg-hint" style="margin-left: 76px">No field: searches every Text field (free text).</div> }
      <div class="lg-fed-actions">
        @if (pill()) { <button class="lg-btn sm danger" (click)="remove.emit()">Remove</button> }
        <span class="lg-sp"></span>
        <button class="lg-btn sm" (click)="cancel.emit()">Cancel</button>
        <button class="lg-btn sm primary" [disabled]="!ready()" (click)="apply()">Apply</button>
      </div>
    </div>
  `,
})
export class LogFilterEditorComponent {
  /** The pill being edited, or null to add one. */
  readonly pill = input<Pill | null>(null);
  readonly fields = input.required<readonly FieldDef[]>();
  /** The sidebar's latest counts: top values per field and how often each field is present. */
  readonly values = input<FieldValues | null>(null);
  /** Pre-filled field for a new filter (e.g. "+ filter on this field"). */
  readonly startField = input<string>('');

  readonly save = output<Pill>();
  readonly remove = output<void>();
  readonly cancel = output<void>();

  private readonly injector = inject(Injector);
  private readonly fieldIn = viewChild<ElementRef<HTMLInputElement>>('fieldIn');

  readonly include = signal(true);
  readonly field = signal('');
  readonly condition = signal<FilterCondition>('is');
  readonly valuesList = signal<readonly string[]>([]);
  readonly value = signal('');
  readonly suggestOpen = signal(false);
  readonly sugIdx = signal(0);
  readonly fieldError = signal('');

  constructor() {
    // The form follows the pill: the explorer reuses this form when another pill is clicked while it is open.
    effect(() => {
      const p = this.pill();
      const start = this.startField();
      untracked(() => {
        const f = p ? pillToForm(p) : { include: true, field: start, condition: 'is' as FilterCondition, values: [], value: '' };
        this.include.set(f.include);
        this.field.set(f.field);
        this.condition.set(f.condition);
        this.valuesList.set(f.values);
        this.value.set(f.value);
        this.fieldError.set('');
      });
    });
    afterNextRender(() => this.fieldIn()?.nativeElement.focus(), { injector: this.injector });
  }

  private readonly labels = computed(() => this.fields().filter((f) => !f.duplicateOf).map((f) => f.label));

  readonly suggestions = computed(() => {
    const q = this.field().trim().toLowerCase();
    return this.fields().filter((f) => !f.duplicateOf && f.label.toLowerCase().includes(q)).slice(0, 40);
  });

  /** The chosen field's most common values with their counts (from the sidebar sample). */
  readonly top = computed(() => this.values()?.fields[this.field()]?.top.slice(0, 8) ?? []);

  readonly ready = computed(() => formToPill(this.form(), this.pill()) !== null);

  private form(): FilterForm {
    return { include: this.include(), field: this.field(), condition: this.condition(), values: this.valuesList(), value: this.value() };
  }

  onField(v: string): void {
    this.field.set(v);
    this.fieldError.set('');
    this.sugIdx.set(0);
    this.suggestOpen.set(true);
  }

  fieldKey(e: KeyboardEvent): void {
    const list = this.suggestions();
    if (!this.suggestOpen() || !list.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.sugIdx.set((this.sugIdx() + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      this.pickField(list[this.sugIdx()].label);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      this.suggestOpen.set(false);
    }
  }

  pickField(label: string): void {
    this.field.set(label);
    this.suggestOpen.set(false);
    this.fieldError.set('');
    if (this.condition() === 'is') this.valuesList.set([]);
  }

  closeSuggestSoon(): void {
    setTimeout(() => this.suggestOpen.set(false), 150);
  }

  /** Changing the condition keeps the value: "is" holds a list, the others one text, so carry it across. */
  setCondition(c: string): void {
    const was = this.condition();
    const next = c as FilterCondition;
    if (was === 'is' && next !== 'is' && this.valuesList().length) this.value.set(this.valuesList().join(', '));
    else if (was !== 'is' && next === 'is' && this.value().trim()) this.valuesList.set(this.value().split(',').map((x) => x.trim()).filter((x) => x !== ''));
    this.condition.set(next);
  }

  onValue(v: string): void {
    if (this.condition() === 'is') this.valuesList.set(v.split(',').map((x) => x.trim()).filter((x) => x !== ''));
    else this.value.set(v);
  }

  toggleValue(v: string): void {
    const cur = [...this.valuesList()];
    const i = cur.indexOf(v);
    if (i >= 0) cur.splice(i, 1);
    else cur.push(v);
    this.valuesList.set(cur);
  }

  apply(): void {
    const f = this.form();
    if (f.field && !this.labels().includes(f.field.trim())) {
      this.fieldError.set(`No field named "${f.field}" - pick one from the suggestions.`);
      return;
    }
    const p = formToPill(f, this.pill());
    if (p) this.save.emit(p);
  }

  icon(f: FieldDef): string {
    return f.type === 'NUMBER' ? '#' : f.type === 'DATETIME' || f.type === 'DATE' ? '◷' : f.type === 'BOOLEAN' ? '◐' : 't';
  }

  presenceText(label: string): string {
    const v = this.values();
    const p = v?.fields[label]?.presence;
    return p === undefined ? '' : `${Math.round(p * 100)}% of lines`;
  }

  nameParts(label: string): { text: string; hit: boolean }[] {
    const q = this.field().trim().toLowerCase();
    const at = q ? label.toLowerCase().indexOf(q) : -1;
    if (at < 0) return [{ text: label, hit: false }];
    return [
      { text: label.slice(0, at), hit: false },
      { text: label.slice(at, at + q.length), hit: true },
      { text: label.slice(at + q.length), hit: false },
    ].filter((x) => x.text);
  }
}
