import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type CwIconName =
  | 'pin'
  | 'minus'
  | 'expand'
  | 'external'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-down'
  | 'plus'
  | 'x'
  | 'pause'
  | 'record'
  | 'sliders'
  | 'eye'
  | 'eye-off'
  | 'outbound'
  | 'inbound'
  | 'mic-off'
  | 'bolt'
  | 'check'
  | 'copy'
  | 'flag'
  | 'trash';

/**
 * The widget's handful of line icons, inline SVG. Alfred has no icon font, and the widget also runs
 * inside a separate PiP/popup window, where inline SVG needs nothing loaded to render.
 */
@Component({
  selector: 'app-cw-icon',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'cw-icon', 'aria-hidden': 'true' },
  template: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      @switch (name()) {
        @case ('pin') {
          <path d="M12 17v5" />
          <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
        }
        @case ('minus') {
          <path d="M5 12h14" />
        }
        @case ('expand') {
          <path d="M15 3h6v6" />
          <path d="M9 21H3v-6" />
          <path d="M21 3l-7 7" />
          <path d="M3 21l7-7" />
        }
        @case ('external') {
          <path d="M15 3h6v6" />
          <path d="M10 14 21 3" />
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        }
        @case ('chevron-left') {
          <path d="m15 18-6-6 6-6" />
        }
        @case ('chevron-right') {
          <path d="m9 18 6-6-6-6" />
        }
        @case ('chevron-down') {
          <path d="m6 9 6 6 6-6" />
        }
        @case ('plus') {
          <path d="M5 12h14" />
          <path d="M12 5v14" />
        }
        @case ('x') {
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        }
        @case ('pause') {
          <rect x="6" y="5" width="4" height="14" rx="1" />
          <rect x="14" y="5" width="4" height="14" rx="1" />
        }
        @case ('record') {
          <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />
        }
        @case ('sliders') {
          <path d="M4 6h9" />
          <path d="M17 6h3" />
          <path d="M4 12h3" />
          <path d="M11 12h9" />
          <path d="M4 18h11" />
          <path d="M19 18h1" />
          <circle cx="15" cy="6" r="2" />
          <circle cx="9" cy="12" r="2" />
          <circle cx="17" cy="18" r="2" />
        }
        @case ('eye') {
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
        }
        @case ('eye-off') {
          <path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68" />
          <path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.39-1.61" />
          <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
          <path d="M2 2l20 20" />
        }
        @case ('outbound') {
          <path d="M7 17 17 7" />
          <path d="M7 7h10v10" />
        }
        @case ('inbound') {
          <path d="M17 7 7 17" />
          <path d="M17 17H7V7" />
        }
        @case ('mic-off') {
          <path d="M2 2l20 20" />
          <path d="M18.89 13.23A7 7 0 0 0 19 12v-2" />
          <path d="M5 10v2a7 7 0 0 0 12 5" />
          <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
          <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
          <path d="M12 19v3" />
        }
        @case ('bolt') {
          <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
        }
        @case ('check') {
          <path d="M20 6 9 17l-5-5" />
        }
        @case ('copy') {
          <rect x="9" y="9" width="12" height="12" rx="2" />
          <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
        }
        @case ('flag') {
          <path d="M4 22V4" />
          <path d="M4 4h13l-2.5 4.5L17 13H4" />
        }
        @case ('trash') {
          <path d="M3 6h18" />
          <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          <path d="M10 11v6" />
          <path d="M14 11v6" />
        }
      }
    </svg>
  `,
})
export class CwIconComponent {
  readonly name = input.required<CwIconName>();
}
