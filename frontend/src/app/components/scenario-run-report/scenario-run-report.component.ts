import { Component, computed, input, signal } from '@angular/core';
import { AssertionResult, DraftResult } from '../../shared/utils/scenario-types';
import { ResendDraft } from '../../shared/utils/resend-draft';
import { buildHtmlReport, buildMarkdownReport, ReportRow, rowsFor } from '../../shared/utils/scenario-run-export';
import { downloadText } from '../../shared/utils/download';

/**
 * D1 - after a scenario run: per-draft pass/fail rows with assertion chips, failures expanded by
 * default so a failure is never one extra click away from what actually went wrong. Export never
 * truncates a failed draft's response body (project-wide hard rule) - see scenario-run-export.ts.
 */
@Component({
  selector: 'app-scenario-run-report',
  standalone: true,
  templateUrl: './scenario-run-report.component.html',
})
export class ScenarioRunReportComponent {
  readonly scenarioName = input('Scenario');
  readonly drafts = input<readonly ResendDraft[]>([]);
  readonly draftResults = input.required<readonly DraftResult[]>();
  readonly assertionResults = input<Readonly<Record<string, readonly AssertionResult[]>>>({});

  readonly rows = computed<ReportRow[]>(() => rowsFor(this.drafts(), this.draftResults(), this.assertionResults()));
  readonly passedCount = computed(() => this.rows().filter((r) => r.passed).length);

  /** Keys whose expanded/collapsed state was explicitly toggled away from its default. */
  private readonly toggled = signal<ReadonlySet<string>>(new Set());

  isExpanded(row: ReportRow): boolean {
    // Failures start expanded (nothing to hunt for); a pass starts collapsed. Either flips on click.
    const defaultExpanded = !row.passed;
    return this.toggled().has(row.key) ? !defaultExpanded : defaultExpanded;
  }

  toggle(row: ReportRow): void {
    this.toggled.update((set) => {
      const next = new Set(set);
      if (next.has(row.key)) next.delete(row.key);
      else next.add(row.key);
      return next;
    });
  }

  exportMarkdown(): void {
    downloadText(buildMarkdownReport(this.rows(), this.scenarioName()), `${this.fileBase()}.md`, 'text/markdown');
  }

  exportHtml(): void {
    downloadText(buildHtmlReport(this.rows(), this.scenarioName()), `${this.fileBase()}.html`, 'text/html');
  }

  private fileBase(): string {
    return `scenario-run-${this.scenarioName().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'report'}`;
  }
}
