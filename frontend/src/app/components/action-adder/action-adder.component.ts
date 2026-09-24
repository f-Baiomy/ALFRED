import { Component, Input } from '@angular/core';
import { ActionType } from '../../core/models/interception.model';
import { ActionPickerComponent } from '../action-picker/action-picker.component';
import type { RuleEditorComponent } from '../rule-editor/rule-editor.component';

/**
 * "Add action" for one action list - a pipeline lane or a condition's branch: the button, a few
 * one-click chips (recently used, else the common ones), and the grouped picker when this list's
 * is the one open. State and insertion stay in RuleEditorComponent (passed as `editor`, like the
 * action card), so an "insert here" on a card can open this same picker at another position.
 */
@Component({
  selector: 'app-action-adder',
  standalone: true,
  imports: [ActionPickerComponent],
  templateUrl: './action-adder.component.html',
})
export class ActionAdderComponent {
  @Input({ required: true }) editor!: RuleEditorComponent;
  @Input({ required: true }) phase!: 'request' | 'response';
  /** [] for a top-level lane, else the branch list's path ([...conditionalPath, branchIndex]). */
  @Input({ required: true }) listPath!: readonly number[];
  @Input({ required: true }) types!: readonly ActionType[];

  get key(): string {
    return this.editor.pickKey(this.phase, this.listPath);
  }

  get open(): boolean {
    return this.editor.pickTarget()?.key === this.key;
  }

  get quick(): readonly ActionType[] {
    return this.editor.quickTypes(this.phase, this.types);
  }
}
