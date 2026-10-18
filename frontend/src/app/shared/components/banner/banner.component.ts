import { Component, input, output } from '@angular/core';

export type BannerTone = 'info' | 'ok' | 'warn' | 'error';

/**
 * One line that says what just happened and, when there is one, what to do (specs/032 D6/D9): "Handed back - Claude
 * stopped", "⚠ Claude didn't start - …  [Try again]". Replaces the silent `error: () => undefined` paths.
 */
@Component({
  selector: 'app-banner',
  standalone: true,
  template: `
    <div class="banner" [class]="'banner banner--' + tone()" [attr.role]="tone() === 'error' || tone() === 'warn' ? 'alert' : 'status'">
      <span class="banner__icon" aria-hidden="true">{{ icon() }}</span>
      <span class="banner__text">
        <b>{{ text() }}</b>
        @if (detail()) { <span class="banner__detail">{{ detail() }}</span> }
      </span>
      @if (action()) { <button type="button" class="action-btn banner__act" (click)="act.emit()">{{ action() }}</button> }
      @if (dismissable()) { <button type="button" class="banner__x" aria-label="Dismiss" (click)="dismiss.emit()">×</button> }
    </div>`,
  styles: [`
    .banner { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 8px; font-size: 12.5px;
      border: 1px solid var(--border, #2a2a2e); background: var(--popover-solid, #1e1e21); color: var(--text, #f2f2f5); }
    .banner--ok { border-color: color-mix(in srgb, var(--green, #7ee3a0) 45%, transparent); }
    .banner--warn { border-color: color-mix(in srgb, var(--amber, #e3a24a) 50%, transparent); }
    .banner--error { border-color: color-mix(in srgb, var(--red, #e36a6a) 55%, transparent); }
    .banner--ok .banner__icon { color: var(--green, #7ee3a0); }
    .banner--warn .banner__icon { color: var(--amber, #e3a24a); }
    .banner--error .banner__icon { color: var(--red, #e36a6a); }
    .banner--info .banner__icon { color: var(--purple-light, #8fb2f7); }
    .banner__text { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; gap: 0 6px; }
    .banner__detail { color: var(--text-dim, #8b8b93); }
    .banner__act { flex: none; }
    .banner__x { flex: none; background: none; border: 0; color: var(--text-faint, #5b5b63); cursor: pointer; font-size: 15px; line-height: 1; }
    .banner__x:hover { color: var(--text, #f2f2f5); }
  `],
})
export class BannerComponent {
  readonly tone = input<BannerTone>('info');
  readonly text = input.required<string>();
  readonly detail = input<string | null>(null);
  readonly action = input<string | null>(null);
  readonly dismissable = input(true);
  readonly act = output<void>();
  readonly dismiss = output<void>();

  icon(): string {
    return { info: 'ℹ', ok: '✓', warn: '⚠', error: '⚠' }[this.tone()];
  }
}
