import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

type Shape =
  | { readonly d: string }
  | { readonly cx: number; readonly cy: number; readonly r: number }
  | { readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly rx?: number };

/**
 * Line icons drawn inline (24×24, 2px stroke in currentColor), so they take the text colour of
 * whatever holds them and render the same everywhere - unlike emoji, which depend on the OS font
 * and showed as empty boxes on some machines. Add a shape list here to add an icon.
 */
const ICONS: Readonly<Record<string, readonly Shape[]>> = {
  clock: [{ cx: 12, cy: 12, r: 9 }, { d: 'M12 7v5l3 3' }],
  list: [{ d: 'M9 6h11M9 12h11M9 18h11' }, { d: 'M5 6v.01M5 12v.01M5 18v.01' }],
  link: [
    { d: 'M9 15l6-6' },
    { d: 'M11 6l.46-.54a5 5 0 0 1 7.07 7.08L18 13' },
    { d: 'M13 18l-.4.53a5.07 5.07 0 0 1-7.12 0a4.97 4.97 0 0 1 0-7.07L6 11' },
  ],
  braces: [
    { d: 'M7 4a2 2 0 0 0-2 2v3a2 3 0 0 1-2 3a2 3 0 0 1 2 3v3a2 2 0 0 0 2 2' },
    { d: 'M17 4a2 2 0 0 1 2 2v3a2 3 0 0 0 2 3a2 3 0 0 0-2 3v3a2 2 0 0 1-2 2' },
  ],
  cookie: [{ d: 'M12 3a9 9 0 1 0 9 9a3 3 0 0 1-3-3a3 3 0 0 1-3-3a3 3 0 0 1-3-3z' }, { d: 'M8.5 10.5v.01M12 15v.01M15.5 14.5v.01M9 15.5v.01' }],
  bolt: [{ d: 'M13 3v7h6l-8 11v-7H5l8-11' }],
  reply: [{ d: 'M9 14l-4-4l4-4' }, { d: 'M5 10h11a4 4 0 1 1 0 8h-1' }],
  branch: [
    { cx: 7, cy: 18, r: 2 },
    { cx: 7, cy: 6, r: 2 },
    { cx: 17, cy: 6, r: 2 },
    { d: 'M7 8v8' },
    { d: 'M17 8v2a4 4 0 0 1-4 4H9' },
  ],
  swap: [{ d: 'M16 3l4 4l-4 4' }, { d: 'M10 7h10' }, { d: 'M8 13l-4 4l4 4' }, { d: 'M4 17h10' }],
  wand: [
    { d: 'M6 21L21 6l-3-3L3 18z' },
    { d: 'M15 6l3 3' },
    { d: 'M9 3a2 2 0 0 0 2 2a2 2 0 0 0-2 2a2 2 0 0 0-2-2a2 2 0 0 0 2-2' },
    { d: 'M19 13a2 2 0 0 0 2 2a2 2 0 0 0-2 2a2 2 0 0 0-2-2a2 2 0 0 0 2-2' },
  ],
  grid: [
    { x: 4, y: 4, w: 6, h: 6, rx: 1 },
    { x: 14, y: 4, w: 6, h: 6, rx: 1 },
    { x: 4, y: 14, w: 6, h: 6, rx: 1 },
    { x: 14, y: 14, w: 6, h: 6, rx: 1 },
  ],
  hourglass: [
    { d: 'M6 20v-2a6 6 0 1 1 12 0v2a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1z' },
    { d: 'M6 4v2a6 6 0 1 0 12 0V4a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z' },
  ],
  alert: [
    { d: 'M10.36 3.59L2.26 17.13a1.91 1.91 0 0 0 1.63 2.87h16.22a1.91 1.91 0 0 0 1.63-2.87L13.64 3.59a1.91 1.91 0 0 0-3.28 0z' },
    { d: 'M12 9v4M12 16h.01' },
  ],
  bubble: [{ d: 'M4 5h16v11H9l-5 4z' }, { d: 'M8 9h8M8 12h5' }],
  pencil: [{ d: 'M4 20h4L18.5 9.5a2.83 2.83 0 1 0-4-4L4 16v4' }, { d: 'M13.5 6.5l4 4' }],
  fork: [{ d: 'M3 12h6l4-5h6' }, { d: 'M9 12l4 5h6' }, { d: 'M17 5l2 2l-2 2' }, { d: 'M17 15l2 2l-2 2' }],
  pause: [
    { x: 6, y: 5, w: 4, h: 14, rx: 1 },
    { x: 14, y: 5, w: 4, h: 14, rx: 1 },
  ],
};

@Component({
  selector: 'app-svg-icon',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'svg-icon', 'aria-hidden': 'true' },
  template: `
    <svg viewBox="0 0 24 24" [attr.width]="size()" [attr.height]="size()" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      @for (s of shapes(); track $index) {
        @if (isPath(s)) {
          <svg:path [attr.d]="s.d" />
        } @else if (isCircle(s)) {
          <svg:circle [attr.cx]="s.cx" [attr.cy]="s.cy" [attr.r]="s.r" />
        } @else if (isRect(s)) {
          <svg:rect [attr.x]="s.x" [attr.y]="s.y" [attr.width]="s.w" [attr.height]="s.h" [attr.rx]="s.rx ?? 0" />
        }
      }
    </svg>
  `,
})
export class SvgIconComponent {
  readonly name = input.required<string>();
  readonly size = input(14);

  readonly shapes = computed(() => ICONS[this.name()] ?? []);

  isPath(s: Shape): s is { d: string } {
    return 'd' in s;
  }

  isCircle(s: Shape): s is { cx: number; cy: number; r: number } {
    return 'r' in s;
  }

  isRect(s: Shape): s is { x: number; y: number; w: number; h: number; rx?: number } {
    return 'w' in s;
  }
}

export const SVG_ICON_NAMES = Object.keys(ICONS);
