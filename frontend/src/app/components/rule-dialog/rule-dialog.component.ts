import { Component, inject } from '@angular/core';
import { RuleDialogService } from '../../core/services/rule-dialog.service';
import { RuleEditorComponent } from '../rule-editor/rule-editor.component';
import type { EditorSnapshot } from '../rule-editor/rule-editor.component';
import { SourceCallRef } from '../../core/models/interception.model';

/**
 * The rule editor as a popup over any page - the same RuleEditorComponent the Interception tab
 * opens, not a copy. Mounted once in main-layout; RuleDialogService says what it opens with.
 * While parked (its "Made from…" call is being looked at) the editor is closed and only the
 * "Return to the rule" bar shows; the form waits in the service as a snapshot.
 */
@Component({
  selector: 'app-rule-dialog',
  standalone: true,
  imports: [RuleEditorComponent],
  template: `
    @if (dialog.request(); as request) {
      @if (dialog.parked()) {
        <div class="rule-return-bar" role="status">
          <span>Editing rule <b>"{{ dialog.parkedTitle() }}"</b> - kept while you look at the call it was made from.</span>
          <button type="button" class="pill on" (click)="dialog.returnToRule()">Return to the rule</button>
          <button type="button" class="pill" (click)="dialog.close()" title="Throw the unsaved changes away">Discard</button>
        </div>
      } @else {
        <!-- Deferred: the editor is the heaviest component there is, and every page mounts this
             dialog - it loads the first time a rule is actually opened here, not at start-up. -->
        @defer (on immediate) {
        <app-rule-editor
          [rule]="request.rule ?? null"
          [snapshot]="request.snapshot ?? null"
          [fromCall]="request.fromCall ?? null"
          (closed)="dialog.close()"
          (goToCall)="goToCall($event, request.rule ?? null)"
        />
        } @loading (minimum 150ms) {
          <div class="dialog-backdrop"></div>
        }
      }
    }
  `,
})
export class RuleDialogComponent {
  readonly dialog = inject(RuleDialogService);

  goToCall(event: { source: SourceCallRef; snapshot: EditorSnapshot }, rule: RuleDialogRequestRule): void {
    this.dialog.goToCall(event.source, event.snapshot, rule);
  }
}

type RuleDialogRequestRule = Parameters<RuleDialogService['goToCall']>[2];
