import { Component, HostListener, inject, signal } from '@angular/core';
import { ConsentService } from '../../core/services/consent.service';

/** The one consent dialog (specs/017 R21), mounted once at the app root so pop-out pages have it too. */
@Component({
  selector: 'app-consent-dialog',
  standalone: true,
  template: `
    @if (consent.state(); as c) {
      <div class="dialog-backdrop consent-backdrop" (click)="consent.respond(false)">
        <div class="dialog-card consent-card" role="alertdialog" aria-modal="true" [attr.aria-label]="c.title" (click)="$event.stopPropagation()">
          <div class="consent-title">🔒 {{ c.title }}</div>
          <div class="consent-from">{{ c.from }} asks to:</div>
          <ul class="consent-lines">@for (l of c.lines; track $index) { <li>{{ l }}</li> }</ul>
          @if (c.exact) { <pre class="consent-exact">{{ c.exact }}</pre> }
          @if (c.remember) {
            <label class="consent-remember"><input type="checkbox" [checked]="remember()" (change)="remember.set(!remember())" />
              Don't ask again for this snippet until the page is reloaded</label>
          }
          <div class="dialog-actions">
            <button type="button" class="dialog-btn secondary" (click)="consent.respond(false)">Cancel</button>
            <button type="button" class="dialog-btn primary" (click)="consent.respond(true, remember())">{{ c.confirmLabel }}</button>
          </div>
        </div>
      </div>
    }`,
})
export class ConsentDialogComponent {
  readonly consent = inject(ConsentService);
  readonly remember = signal(false);

  @HostListener('document:keydown.escape')
  escape(): void {
    if (this.consent.state()) this.consent.respond(false);
  }
}
