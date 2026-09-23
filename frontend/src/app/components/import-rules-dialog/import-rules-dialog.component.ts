import { Component, ElementRef, computed, inject, output, signal, viewChild } from '@angular/core';
import {
  InterceptionRuleDraft,
  RuleImportOutcome,
  RuleImportResult,
  describeAction,
  describeMatch,
  isTerminalAction,
} from '../../core/models/interception.model';
import { InterceptionStateService } from '../../core/state/interception-state.service';
import { parseRulesFile } from '../../shared/utils/interception-rules-file';

/** One row of the preview: the rule, and what is worth knowing about it before it exists. */
export interface RulePreview {
  readonly index: number;
  readonly rule: InterceptionRuleDraft;
  readonly match: string;
  readonly actions: readonly string[];
  /** This rule can hold a real caller's connection open. */
  readonly pauses: boolean;
  /** This rule ends the request - aborts it, or answers without contacting the host. */
  readonly terminal: boolean;
  /** A rule with this name already exists here; importing adds a second one. */
  readonly nameClash: boolean;
}

/**
 * Reading an exported rules file before it runs.
 *
 * The preview is the whole point of this dialog, not decoration around a file picker. A rules
 * file is executable: it can pause real requests, abort connections and rewrite bodies on live
 * traffic. Importing one somebody sent you without seeing what is in it is the thing this exists
 * to prevent - so the dangerous rules are called out by name before anything is created, and
 * nothing arrives switched on unless it is explicitly asked for.
 */
@Component({
  selector: 'app-import-rules-dialog',
  standalone: true,
  templateUrl: './import-rules-dialog.component.html',
})
export class ImportRulesDialogComponent {
  private readonly state = inject(InterceptionStateService);

  readonly closed = output<void>();

  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');

  readonly fileName = signal<string | null>(null);
  readonly fileSize = signal(0);
  readonly parseError = signal<string | null>(null);
  readonly draggingOver = signal(false);
  readonly enableAfterImport = signal(false);
  readonly importing = signal(false);

  private readonly parsed = signal<readonly InterceptionRuleDraft[]>([]);

  /** Set once the import has run - the dialog then shows what happened instead of what would. */
  readonly result = signal<RuleImportResult | null>(null);

  readonly previews = computed<readonly RulePreview[]>(() => {
    const existing = new Set(this.state.rules().map((r) => r.name));
    return this.parsed().map((rule, index) => {
      // Every field is treated as missing-until-proven-present, and that is not defensiveness
      // for its own sake: the whole job of this preview is to describe a file nobody here wrote.
      // A rule with no `match` at all threw out of describeMatch, and because this is a computed
      // the throw took the entire dialog's rendering with it - a blank panel instead of the
      // preview of the untrusted file, at exactly the moment you need to read it. The backend
      // rejects such a rule with a proper message; getting that far is the point.
      const actions = (rule.actions ?? []).filter((a) => a && typeof a.type === 'string');
      return {
        index,
        rule,
        match: describeMatch(rule.match ?? {}, this.state.sensitiveNames()),
        actions: actions.map((a) => describeAction(a)),
        pauses: actions.some((a) => a.type.startsWith('PAUSE_')),
        terminal: actions.some((a) => isTerminalAction(a.type)),
        nameClash: !!rule.name && existing.has(rule.name),
      };
    });
  });

  readonly pausingCount = computed(() => this.previews().filter((p) => p.pauses).length);
  readonly clashCount = computed(() => this.previews().filter((p) => p.nameClash).length);
  readonly hasFile = computed(() => this.parsed().length > 0);

  /** Rejections from the server, for the after-the-fact view. */
  readonly rejections = computed<readonly RuleImportOutcome[]>(
    () => this.result()?.results.filter((r) => r.status === 'rejected') ?? []
  );

  browse(): void {
    this.fileInput()?.nativeElement.click();
  }

  onFileChosen(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) this.read(file);
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.draggingOver.set(true);
  }

  onDragLeave(): void {
    this.draggingOver.set(false);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.draggingOver.set(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) this.read(file);
  }

  private read(file: File): void {
    this.fileName.set(file.name);
    this.fileSize.set(file.size);
    this.result.set(null);
    const reader = new FileReader();
    reader.onload = () => {
      const parse = parseRulesFile(String(reader.result ?? ''));
      this.parseError.set(parse.error);
      this.parsed.set(parse.rules);
    };
    reader.onerror = () => {
      this.parseError.set('That file could not be read.');
      this.parsed.set([]);
    };
    reader.readAsText(file);
  }

  clearFile(): void {
    this.fileName.set(null);
    this.fileSize.set(0);
    this.parsed.set([]);
    this.parseError.set(null);
    this.result.set(null);
    const input = this.fileInput()?.nativeElement;
    // Cleared, or choosing the same file again fires no change event and nothing happens.
    if (input) input.value = '';
  }

  runImport(): void {
    if (!this.hasFile() || this.importing()) return;
    this.importing.set(true);
    this.state.importRules(this.parsed(), this.enableAfterImport()).subscribe({
      next: (result) => {
        this.importing.set(false);
        this.result.set(result);
      },
      error: () => {
        this.importing.set(false);
        this.parseError.set('The import could not be sent. Check that the backend is reachable.');
      },
    });
  }

  close(): void {
    this.closed.emit();
  }

  sizeLabel(): string {
    const bytes = this.fileSize();
    return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
  }
}
