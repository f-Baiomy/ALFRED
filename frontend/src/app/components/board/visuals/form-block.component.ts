import { Component, computed, inject, input, signal } from '@angular/core';
import { BoardActionsService, ActionContext } from '../../../core/services/board-actions.service';

export interface FormField {
  readonly name: string;
  readonly label: string;
  readonly type: 'text' | 'textarea' | 'select' | 'check' | 'number';
  readonly options: readonly string[];
}

export interface FormSpec {
  readonly title: string;
  readonly fields: readonly FormField[];
  readonly submit: string;
  readonly error: string | null;
}

/**
 * ```form``` (specs/017 R22), one line each:
 * `title: Which fix?` · `field: approach | Approach | select: Per rule, Per session` · `field: note | Anything else? | text`
 * (types: text, textarea, number, check, select: a, b) · `submit: Send answer`.
 */
export function parseForm(text: string): FormSpec {
  let title = '';
  let submit = 'Send answer';
  const fields: FormField[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(title|field|submit)\s*:\s*(.*)$/i.exec(line);
    if (!m) return { title, fields, submit, error: `"${line}" - a form line is title:, field: or submit:` };
    const key = m[1].toLowerCase();
    if (key === 'title') { title = m[2]; continue; }
    if (key === 'submit') { submit = m[2] || submit; continue; }
    const parts = m[2].split('|').map((p) => p.trim());
    const name = parts[0];
    if (!/^[\w-]{1,40}$/.test(name)) return { title, fields, submit, error: `field "${name}" - a field's name is a word` };
    const kind = (parts[2] ?? 'text');
    const sel = /^select\s*:\s*(.+)$/i.exec(kind);
    const type = sel ? 'select' : (['text', 'textarea', 'check', 'number'].includes(kind.toLowerCase()) ? kind.toLowerCase() : null);
    if (!type) return { title, fields, submit, error: `field "${name}": its type is text, textarea, number, check or select: a, b` };
    fields.push({ name, label: parts[1] || name, type: type as FormField['type'], options: sel ? sel[1].split(',').map((o) => o.trim()).filter(Boolean) : [] });
  }
  if (!fields.length) return { title, fields, submit, error: 'A form needs at least one field: line' };
  return { title, fields, submit, error: null };
}

/** The answer a form posts: `field=value; …` - what Claude reads back. */
export function formAnswer(fields: readonly FormField[], values: Readonly<Partial<Record<string, string | boolean>>>): string {
  return fields.map((f) => `${f.name}=${f.type === 'check' ? (values[f.name] ? 'yes' : 'no') : String(values[f.name] ?? '').replace(/;/g, ',').trim()}`).join('; ');
}

@Component({
  selector: 'app-form-block',
  standalone: true,
  template: `
    @if (spec(); as s) {
      @if (s.error) {
        <div class="board-vis"><div class="board-vis-err">{{ s.error }}</div><pre class="board-vis-src">{{ source() }}</pre></div>
      } @else {
        <form class="board-form" (submit)="$event.preventDefault(); send()">
          @if (s.title) { <div class="board-form-title">{{ s.title }}</div> }
          @for (f of s.fields; track f.name) {
            @switch (f.type) {
              @case ('check') { <label class="board-form-check"><input type="checkbox" [checked]="!!values()[f.name]" (change)="set(f.name, $any($event.target).checked)" />{{ f.label }}</label> }
              @case ('select') {
                <label>{{ f.label }}<select [value]="values()[f.name] ?? ''" (change)="set(f.name, $any($event.target).value)">
                  <option value="">-</option>@for (o of f.options; track o) { <option [value]="o">{{ o }}</option> }</select></label>
              }
              @case ('textarea') { <label>{{ f.label }}<textarea rows="3" [value]="values()[f.name] ?? ''" (input)="set(f.name, $any($event.target).value)"></textarea></label> }
              @default { <label>{{ f.label }}<input [type]="f.type === 'number' ? 'number' : 'text'" [value]="values()[f.name] ?? ''" (input)="set(f.name, $any($event.target).value)" /></label> }
            }
          }
          <div class="board-form-foot">
            @if (note(); as n) { <span class="board-dim">{{ n }}</span> }
            <button type="submit" class="action-btn primary" [disabled]="!canSend() || busy()">{{ s.submit }}</button>
          </div>
        </form>
      }
    }`,
})
export class FormBlockComponent {
  readonly source = input.required<string>();
  readonly context = input<ActionContext>({});
  /** Off in previews (the editor's split view, exports): nothing is posted from there. */
  readonly canSend = input(true);

  private readonly actions = inject(BoardActionsService);
  readonly spec = computed(() => parseForm(this.source()));
  readonly values = signal<Readonly<Partial<Record<string, string | boolean>>>>({});
  readonly busy = signal(false);
  readonly note = signal<string | null>(null);

  set(name: string, v: string | boolean): void {
    this.values.update((x) => ({ ...x, [name]: v }));
  }

  async send(): Promise<void> {
    const s = this.spec();
    if (s.error || !this.canSend()) return;
    this.busy.set(true);
    try {
      await this.actions.perform('answer', { text: formAnswer(s.fields, this.values()) }, this.context(), 'This form');
      this.note.set('✓ Sent as your answer');
    } catch (e) {
      this.note.set(e instanceof Error && e.message !== 'The user said no' ? e.message : null);
    } finally {
      this.busy.set(false);
    }
  }
}
