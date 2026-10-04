import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DbWindowComponent } from './db-window.component';
import { DbWindowService } from './db-window.service';

/** Renders the database window once for the whole app, whenever a ◆ DB chip asks for it. */
@Component({
  standalone: true,
  selector: 'app-db-window-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DbWindowComponent],
  template: `
    <!-- keyed by the request object, so opening another call while one is open starts a fresh window -->
    @for (request of requests(); track request) {
      <!-- deferred: the window's code loads the first time a chip opens it, not with the app shell -->
      @defer {
        <app-db-window [request]="request" (closed)="service.close()" />
      }
    }
  `,
})
export class DbWindowHostComponent {
  protected readonly service = inject(DbWindowService);
  protected readonly requests = computed(() => {
    const r = this.service.request();
    return r ? [r] : [];
  });
}
