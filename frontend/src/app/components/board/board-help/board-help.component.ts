import { Component, output } from '@angular/core';

/** The board's keys (`?`). */
@Component({
  selector: 'app-board-help',
  standalone: true,
  template: `
    <div class="dialog-backdrop" (click)="closed.emit()">
      <div class="dialog-card board-help" (click)="$event.stopPropagation()">
        <h2>Keyboard</h2>
        <table>
          <tr><td><kbd>J</kbd> / <kbd>K</kbd></td><td>next / previous card</td></tr>
          <tr><td><kbd>Enter</kbd></td><td>open card</td></tr>
          <tr><td><kbd>F</kbd> <kbd>N</kbd> <kbd>T</kbd></td><td>Inbox card: Fine · Not in this flow · To do</td></tr>
          <tr><td><kbd>1</kbd>-<kbd>6</kbd></td><td>move to Inbox … Done</td></tr>
          <tr><td><kbd>U</kbd></td><td>toggle Urgent</td></tr>
          <tr><td><kbd>X</kbd> / Shift+click</td><td>select for a bulk action</td></tr>
          <tr><td><kbd>/</kbd></td><td>quick add</td></tr>
          <tr><td><kbd>L</kbd></td><td>board / list</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>close</td></tr>
        </table>
        <button type="button" class="action-btn" (click)="closed.emit()">Close</button>
      </div>
    </div>`,
})
export class BoardHelpComponent {
  readonly closed = output<void>();
}
