import { Component } from '@angular/core';

/**
 * The Relive Cycles list page (FR-001 onward). Placeholder shell wired up by T004; T023 fills
 * it in with the real table, empty state and "New cycle" flow (mock.html listView()).
 */
@Component({
  selector: 'app-relive-list',
  standalone: true,
  template: `<div class="relive-placeholder">Relive Cycles</div>`,
})
export class ReliveListComponent {}
