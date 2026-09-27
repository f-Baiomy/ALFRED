import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CycleWidgetWindowService } from '../../core/services/cycle-widget-window.service';

/** The tab that opens (or brings forward) the floating cycle widget - on the right edge of every page, stacked above the global variables tab. */
@Component({
  selector: 'app-cycle-widget-launch',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'cw-launch', role: 'button', tabindex: '0', '[class.open]': 'win.isOpen()', '[class.repin]': 'win.repinRequested()', '[title]': 'title()', '(click)': 'open()', '(keydown.enter)': 'open()', '(keydown.space)': '$event.preventDefault(); open()' },
  template: `
    <!-- Inline rather than CwIconComponent, which would pull every widget icon into the main bundle. -->
    <svg class="cw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <rect x="12" y="12" width="7" height="6" rx="1" fill="currentColor" stroke="none" />
    </svg>
    {{ win.repinRequested() ? 'Pin on top' : 'Cycle widget' }}
    @if (win.isOpen() && win.recording()) {
      <span class="cw-launch-rec" aria-label="Recording"></span>
    }
    <!-- The widget's own window shows its notices; this covers the case where no window opened at all. -->
    @if (!win.isOpen() && win.notice(); as notice) {
      <span class="cw-launch-notice" role="alert">{{ notice }}</span>
    }
  `,
})
export class CycleWidgetLaunchComponent {
  readonly win = inject(CycleWidgetWindowService);

  open(): void {
    void this.win.open();
  }

  title(): string {
    if (this.win.repinRequested()) return 'Pin the cycle widget on top of other apps';
    if (this.win.isOpen()) return this.win.recording() ? 'Bring the cycle widget forward - its cycle is recording' : 'Bring the cycle widget forward';
    return this.win.pipSupported ? 'Pop out a floating cycle widget that stays on top of other apps' : 'Open the cycle widget in its own window';
  }
}
