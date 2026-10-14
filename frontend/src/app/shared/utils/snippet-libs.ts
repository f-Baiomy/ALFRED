/**
 * The library shelf (specs/017 R25): libraries Alfred ships, served from its own address at /lib/<id>/<major>/…, so a
 * snippet can use them with no network. angular.json copies each file from node_modules; snippet-libs.spec.ts checks
 * every entry here has its copy rule, so the two cannot drift. `libs="echarts chartjs"` on a snippet loads them for it.
 */
export interface SnippetLib {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /** Path under /lib/. */
  readonly file: string;
  /** script (a global), module (import it), css (a stylesheet). */
  readonly kind: 'script' | 'module' | 'css';
  /** What a snippet gets: the global name, or the module specifier the import map gives it. */
  readonly provides: string;
  readonly about: string;
  /** Loaded only when a snippet asks for it (big). */
  readonly heavy?: boolean;
}

export const SNIPPET_LIBS: readonly SnippetLib[] = [
  { id: 'chartjs', name: 'Chart.js', version: '4.4.4', file: 'chartjs/4/chart.umd.js', kind: 'script', provides: 'Chart', about: 'charts' },
  { id: 'echarts', name: 'ECharts', version: '5.5.1', file: 'echarts/5/echarts.min.js', kind: 'script', provides: 'echarts', about: 'rich, animated charts' },
  { id: 'd3', name: 'D3', version: '7.9.0', file: 'd3/7/d3.min.js', kind: 'script', provides: 'd3', about: 'any data visual' },
  { id: 'plotly', name: 'Plotly', version: '2.35.2', file: 'plotly/2/plotly.min.js', kind: 'script', provides: 'Plotly', about: 'scientific charts', heavy: true },
  { id: 'mermaid', name: 'Mermaid', version: '11.4.1', file: 'mermaid/11/mermaid.min.js', kind: 'script', provides: 'mermaid', about: 'diagrams', heavy: true },
  { id: 'three', name: 'Three.js', version: '0.169.0', file: 'three/0.169/three.module.min.js', kind: 'module', provides: 'three', about: '3D' },
  { id: 'preact', name: 'Preact', version: '10.24.3', file: 'preact/10/preact.module.js', kind: 'module', provides: 'preact', about: 'components' },
  { id: 'preact-hooks', name: 'Preact hooks', version: '10.24.3', file: 'preact/10/hooks.module.js', kind: 'module', provides: 'preact/hooks', about: 'useState, useEffect…' },
  { id: 'htm', name: 'htm', version: '3.1.1', file: 'htm/3/htm.module.js', kind: 'module', provides: 'htm', about: 'JSX-like templates without a build' },
  { id: 'htm-preact', name: 'htm + Preact', version: '3.1.1', file: 'htm/3/standalone.module.js', kind: 'module', provides: 'htm/preact', about: 'html`…` with Preact' },
  { id: 'alpine', name: 'Alpine.js', version: '3.14.3', file: 'alpine/3/cdn.min.js', kind: 'script', provides: 'Alpine', about: 'small interactions in markup' },
  { id: 'tailwind', name: 'Tailwind', version: '4.0.0', file: 'tailwind/4/index.mjs', kind: 'module', provides: '(styles)', about: 'utility classes' },
  { id: 'marked', name: 'Marked', version: '14.1.3', file: 'marked/14/marked.min.js', kind: 'script', provides: 'marked', about: 'Markdown to HTML' },
  { id: 'highlight', name: 'highlight.js', version: '11.10.0', file: 'highlight/11/highlight.min.js', kind: 'script', provides: 'hljs', about: 'code colours' },
  { id: 'highlight-css', name: 'highlight.js theme', version: '11.10.0', file: 'highlight/11/github-dark.min.css', kind: 'css', provides: '(styles)', about: 'dark code theme' },
  { id: 'papaparse', name: 'PapaParse', version: '5.4.1', file: 'papaparse/5/papaparse.min.js', kind: 'script', provides: 'Papa', about: 'CSV' },
  { id: 'dayjs', name: 'Day.js', version: '1.11.13', file: 'dayjs/1/dayjs.min.js', kind: 'script', provides: 'dayjs', about: 'dates' },
  { id: 'lodash', name: 'lodash', version: '4.17.21', file: 'lodash/4/lodash.min.js', kind: 'script', provides: '_', about: 'helpers' },
];

/** `libs="echarts@5 chartjs, d3"` → the shelf entries (unknown names are skipped). Version suffixes are only a hint. */
export function libsOf(attr: string | undefined): SnippetLib[] {
  if (!attr) return [];
  const ids = attr.split(/[\s,]+/).map((x) => x.replace(/@.*$/, '').toLowerCase()).filter(Boolean);
  const out: SnippetLib[] = [];
  for (const id of ids) {
    const want = id === 'chart.js' ? 'chartjs' : id === 'three.js' ? 'three' : id;
    for (const lib of SNIPPET_LIBS) {
      if ((lib.id === want || lib.id === `${want}-css` || (want === 'preact' && lib.id === 'preact-hooks') || (want === 'htm' && lib.id === 'htm-preact'))
        && !out.includes(lib)) out.push(lib);
    }
  }
  return out;
}

/** The import map every frame gets, so `import { h } from "preact"` works inside a snippet. */
export function importMap(origin: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const lib of SNIPPET_LIBS) if (lib.kind === 'module' && lib.provides !== '(styles)') map[lib.provides] = `${origin}/lib/${lib.file}`;
  return map;
}
