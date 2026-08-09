/** Every theme id must have a matching `[data-theme="..."]` CSS variable block in styles.scss - the two are kept in sync by hand since there's no build-time check tying them together. */
export type ThemeId = 'dark' | 'light' | 'light-glass' | 'easy' | 'dracula' | 'midnight' | 'dark-glass' | 'slate';

export interface ThemeOption {
  readonly id: ThemeId;
  readonly label: string;
  /** A CSS `background` value (solid color or gradient) used for this theme's swatch button in the picker - deliberately independent of the theme's actual CSS variables so the picker keeps working even before `data-theme` is applied. */
  readonly swatch: string;
}

export const DEFAULT_THEME: ThemeId = 'dark';

export const THEMES: readonly ThemeOption[] = [
  { id: 'dark', label: 'Dark', swatch: '#0a0e2a' },
  { id: 'light', label: 'Light', swatch: '#eef1f6' },
  { id: 'light-glass', label: 'Light glass', swatch: 'linear-gradient(135deg, #7dd3fc, #c4b5fd)' },
  { id: 'easy', label: 'Easy', swatch: '#ffffff' },
  { id: 'dracula', label: 'Dracula', swatch: '#282a36' },
  { id: 'midnight', label: 'Midnight (AMOLED)', swatch: '#000000' },
  { id: 'dark-glass', label: 'Dark glass', swatch: 'linear-gradient(160deg, #241f3d, #141220 60%)' },
  { id: 'slate', label: 'Slate', swatch: '#141416' },
];
