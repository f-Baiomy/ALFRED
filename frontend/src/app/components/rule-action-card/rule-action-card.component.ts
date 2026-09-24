import { CdkDrag, CdkDragHandle, CdkDropList } from '@angular/cdk/drag-drop';
import { Component, Input, forwardRef } from '@angular/core';
import { RuleAction, isActionEnabled } from '../../core/models/interception.model';
import { SelectPickerComponent } from '../select-picker/select-picker.component';
import { StatusPickerComponent } from '../status-picker/status-picker.component';
import { HelpPopoverComponent } from '../help-popover/help-popover.component';
import { AnswerPickerComponent } from '../answer-picker/answer-picker.component';
import { BodyEditorComponent } from '../body-editor/body-editor.component';
import { HeaderEditorComponent } from '../header-editor/header-editor.component';
import { CopyFromCallComponent } from '../copy-from-call/copy-from-call.component';
import { ReplacePreviewComponent } from '../replace-preview/replace-preview.component';
import type { RuleEditorComponent } from '../rule-editor/rule-editor.component';

/**
 * One action in a rule, and where it sits. `index` is the position in the REAL list, so move and
 * remove act on the right action even though the pipeline lanes are filtered views over one array.
 */
export interface ActionStep {
  readonly action: RuleAction;
  readonly index: number;
  readonly path: readonly number[];
  /** True when an ancestor condition is switched off, so this card draws dimmed without its own `enabled` being touched. */
  readonly parentDisabled?: boolean;
}

/**
 * One action card in the rule editor - a plain action, or a condition with its branches, each of
 * which renders this same component again for whatever is nested inside it.
 *
 * **A component rather than an `<ng-template>` + `ngTemplateOutlet`, and that is the whole point.**
 * CDK wires a drag to its list purely through dependency injection: `CdkDrag` injects
 * `CDK_DROP_LIST` and calls `addItem()` on whatever it finds, with no content query anywhere. An
 * embedded view resolves DI against the place its template was DECLARED, not the place it was
 * inserted - so while these cards came from one `<ng-template>` at the root of the rule editor,
 * every `cdkDrag` looked for a list at the root, found none, and silently became a CDK **free
 * drag**: the card followed the pointer, stayed wherever it was dropped, and never produced a
 * placeholder, a sibling shuffle, or a `cdkDropListDropped` event. Measured before the fix:
 * `dropContainer` null, and the lane's list holding 0 items.
 *
 * A component's view resolves DI up through its HOST element instead, so `cdkDrag` written on
 * `<app-rule-action-card>` at the usage site - lexically inside the `cdkDropList` - is a normal
 * child of that list, and the `cdkDragHandle` in this template finds that drag through the host.
 * This is exactly how the session-cycle call list already works (`<app-call-card cdkDrag>` with
 * its handle inside the card's own template), which is the behaviour this had to match.
 *
 * Every field and control still belongs to RuleEditorComponent, passed in as `editor`: this card
 * owns layout and nesting, not rule state, and moving ~40 handlers here would have split one
 * form's logic across two files for no gain.
 */
@Component({
  selector: 'app-rule-action-card',
  standalone: true,
  imports: [
    SelectPickerComponent,
    StatusPickerComponent,
    AnswerPickerComponent,
    BodyEditorComponent,
    HeaderEditorComponent,
    CopyFromCallComponent,
    ReplacePreviewComponent,
    HelpPopoverComponent,
    CdkDropList,
    CdkDrag,
    CdkDragHandle,
    forwardRef(() => RuleActionCardComponent),
  ],
  templateUrl: './rule-action-card.component.html',
})
export class RuleActionCardComponent {
  @Input({ required: true }) step!: ActionStep;

  /** The form this card belongs to. Typed as an import type only, so there is no runtime import cycle. */
  @Input({ required: true }) editor!: RuleEditorComponent;

  /** Dimmed when this action is off, or when any condition above it is. */
  get off(): boolean {
    return !isActionEnabled(this.step.action) || !!this.step.parentDisabled;
  }
}
