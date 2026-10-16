import { SnippetLib, SNIPPET_LIBS, importMap, libsOf } from './snippet-libs';
import { PYODIDE_DIR, PYTHON_CSS, pythonBody } from './snippet-python';

/**
 * The locked frame an HTML snippet runs in (specs/017 R10-R13). Everything that makes a snippet safe lives here and
 * nowhere else, and snippet-security.spec.ts fails if any of it is loosened:
 *
 * - the frame's sandbox is `allow-scripts` and nothing more: no same-origin (the snippet cannot read Alfred's cookies,
 *   storage or DOM), no popups, no top navigation, no forms;
 * - the document starts with a Content-Security-Policy that allows no network at all - only inline code and Alfred's own
 *   library shelf at /lib/ - so nothing the snippet sees can leave the frame;
 * - the snippet's source is put in the body AFTER that policy, so not one byte of it runs before the policy applies.
 */
export const SNIPPET_SANDBOX = 'allow-scripts';

/** No network: inline code, /lib/ and Alfred's own pictures only. A Python snippet may also read the shelf's Python folder. */
export function snippetCsp(origin: string, python = false): string {
  const lib = `${origin}/lib/`;
  return [
    `default-src 'none'`,
    `script-src 'unsafe-inline' 'unsafe-eval' blob: ${lib}`,
    `style-src 'unsafe-inline' ${lib}`,
    `img-src data: blob: ${lib} ${origin}/board/images/`,
    `font-src data: ${lib}`,
    `media-src data: blob:`,
    `worker-src blob:`,
    python ? `connect-src ${origin}/lib/${PYODIDE_DIR}/` : `connect-src 'none'`,
    `frame-src 'none'`,
    `form-action 'none'`,
    `base-uri 'none'`,
  ].join('; ');
}

export interface SnippetDocOptions {
  /** The snippet: HTML, or a diagram/program source when kind says so. */
  readonly source: string;
  readonly kind?: 'html' | 'mermaid' | 'python';
  /** `libs="echarts chartjs"`. */
  readonly libs?: string;
  readonly origin: string;
  readonly dir?: 'ltr' | 'rtl' | 'auto';
  readonly name?: string;
  /** Where the snippet lives, passed to it as `alfred.card` etc. */
  readonly context?: Record<string, unknown>;
  /** Theme colours as CSS variables (`--text` → value). */
  readonly vars?: Record<string, string>;
  /** For an exported page: answers given without a bridge (specs/017 R43). */
  readonly staticAnswers?: Record<string, unknown>;
  /** A frame inside an exported page: it answers from staticAnswers instead of asking the page it sits in. */
  readonly offline?: boolean;
  /**
   * The libraries' code by file, when the frame cannot load /lib/ itself (SnippetShelfService) or for the ⬇ .html
   * download: scripts and styles go in inline, modules become blob URLs in an import map the runtime writes.
   */
  readonly inline?: Readonly<Record<string, string>>;
}

/** The shelf entries a document loads up front. */
export function libsForDoc(o: Pick<SnippetDocOptions, 'libs' | 'kind'>): SnippetLib[] {
  const libs = [...libsOf(o.libs)];
  if (o.kind === 'mermaid' && !libs.some((l) => l.id === 'mermaid')) libs.push(...libsOf('mermaid'));
  return libs;
}

/** A file of a multi-file snippet: `--- chart.js` on a line of its own starts it (specs/017 R26). */
const FILE_LINE = /^---[ \t]+([A-Za-z0-9_][\w.-]{0,80}\.(?:js|mjs|css|json|csv|txt|svg|md))[ \t]*$/;
export const MAX_SNIPPET_FILES = 20;

/**
 * A snippet's source as its page and its files: the text before the first `--- name.ext` line is the page; each such
 * line starts a file that runs to the next one. A source without such a line is all page.
 */
export function splitSnippetFiles(source: string): { main: string; files: Record<string, string>; error: string | null } {
  const main: string[] = [];
  const parts: [string, string[]][] = [];
  let current = main;
  let error: string | null = null;
  for (const line of source.split(/\r?\n/)) {
    const m = FILE_LINE.exec(line);
    if (!m) {
      current.push(line);
      continue;
    }
    if (parts.some(([n]) => n === m[1])) error = `Two files are named ${m[1]} - the last one is used`;
    if (parts.length >= MAX_SNIPPET_FILES) {
      error = `At most ${MAX_SNIPPET_FILES} files in one snippet - the rest are left out`;
      break;
    }
    current = [];
    parts.push([m[1], current]);
  }
  return { main: main.join('\n'), files: Object.fromEntries(parts.map(([n, l]) => [n, l.join('\n')])), error };
}

const isModuleFile = (n: string) => /\.m?js$/i.test(n);

/** `./chart.js` in an import becomes `@file/chart.js`, which the frame's import map points at the file. */
function rewriteImports(code: string, files: Record<string, string>): string {
  return code.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])\.\/([\w.-]+\.m?js)\2/g,
    (all, pre: string, q: string, name: string) => (name in files ? `${pre}${q}@file/${name}${q}` : all));
}

/** The page's own references to its files: stylesheets are applied anyway, classic scripts go in place, modules by the map. */
function rewriteMain(html: string, files: Record<string, string>): string {
  return rewriteImports(html, files)
    .replace(/<link\b[^>]*\bhref=(["'])\.\/([\w.-]+\.css)\1[^>]*>/gi, (all, _q: string, name: string) => (name in files ? '' : all))
    .replace(/<script\b([^>]*)\bsrc=(["'])\.\/([\w.-]+\.m?js)\2([^>]*)>\s*<\/script>/gi, (all, a: string, _q: string, name: string, b: string) => {
      if (!(name in files)) return all;
      return /\btype=(["'])module\1/i.test(a + b)
        ? `<script type="module">import "@file/${name}";</script>`
        : `<script>${rewriteImports(files[name], files).replace(/<\/(script)/gi, '<\\/$1')}</script>`;
    });
}

/** The whole document for the frame's srcdoc - and, unchanged, the ⬇ .html download. */
export function buildSnippetDoc(o: SnippetDocOptions): string {
  const libs = libsForDoc(o);
  const split = o.kind === 'mermaid' ? { main: o.source, files: {} as Record<string, string>, error: null } : splitSnippetFiles(o.source);
  const files = Object.fromEntries(Object.entries(split.files).map(([n, t]) => [n, isModuleFile(n) ? rewriteImports(t, split.files) : t]));
  const hasFiles = Object.keys(files).length > 0;
  const python = o.kind === 'python';
  const body = o.kind === 'mermaid' ? mermaidBody(o.source)
    : python ? pythonBody(split.main, o.origin, scriptJson)
    : (split.error ? `<script>console.error(${scriptJson(split.error)})</script>` : '') + scopeClassicScripts(stripDoctype(hasFiles ? rewriteMain(split.main, split.files) : split.main));
  const inline = o.inline ?? null;
  const modules = inline
    ? Object.fromEntries(libs.filter((l) => l.kind === 'module' && l.provides !== '(styles)' && inline[l.file] !== undefined).map((l) => [l.provides, inline[l.file]]))
    : null;
  const safeVars = Object.fromEntries(Object.entries(o.vars ?? {}).filter(([k, v]) => /^--[\w-]+$/.test(k) && !/[;{}<]/.test(v)));
  const boot = {
    name: o.name ?? '',
    dir: o.dir ?? 'auto',
    context: o.context ?? {},
    libs: Object.fromEntries(SNIPPET_LIBS.map((l) => [l.id, `${o.origin}/lib/${l.file}`])),
    vars: safeVars,
    palette: SNIPPET_PALETTE,
    static: o.staticAnswers ?? null,
    offline: !!o.offline,
    direct: !inline,
    modules,
    // With files, the runtime writes the one import map (the shelf's and the files'): there may be only one.
    imports: !inline && hasFiles ? importMap(o.origin) : null,
    files: hasFiles ? files : null,
    // Python says it is ready when it has run, so the picture Claude sees is the result, not "Starting Python…".
    holdReady: python,
    // Scripts and styles as data, written into the page by the runtime: library code is never parsed as HTML.
    inline: inline ? {
      scripts: libs.filter((l) => (l.kind === 'script' || (l.kind === 'module' && l.provides === '(styles)')) && inline[l.file] !== undefined).map((l) => inline[l.file]),
      styles: libs.filter((l) => l.kind === 'css' && inline[l.file] !== undefined).map((l) => inline[l.file]),
    } : null,
  };
  const vars = Object.entries(safeVars).map(([k, v]) => `${k}:${v}`).join(';');
  return '<!doctype html><html' + (o.dir && o.dir !== 'auto' ? ` dir="${o.dir}"` : '') + '><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${attr(snippetCsp(o.origin, python))}">`
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + (inline || hasFiles ? '' : `<script type="importmap">${scriptJson({ imports: importMap(o.origin) })}</script>`)
    + `<style>:root{${vars}}${BASE_CSS}${python ? PYTHON_CSS : ''}</style>`
    + `<script type="application/json" id="alfred-boot">${scriptJson(boot)}</script>`
    + `<script>${SNIPPET_RUNTIME}</script>`
    + (inline ? '' : libs.map((l) => libTag(l, o.origin)).join(''))
    + `<script>${THEME_SCRIPT}</script>`
    + '</head><body>' + body + '</body></html>';
}

function libTag(l: SnippetLib, origin: string): string {
  const url = `${origin}/lib/${l.file}`;
  if (l.kind === 'css') return `<link rel="stylesheet" href="${url}">`;
  // A module library is reached through the import map; the one exception is Tailwind, a script that styles the page.
  if (l.kind === 'module') return l.provides === '(styles)' ? `<script src="${url}"></script>` : '';
  return `<script src="${url}"></script>`;
}

/** A doctype inside the body is ignored by the parser anyway; dropping it keeps the source's own <html>/<head> harmless. */
function stripDoctype(s: string): string {
  return s.replace(/^\s*<!doctype[^>]*>/i, '');
}

/** A diagram drawn by Mermaid inside the frame: `strict` keeps labels as text and scripts out of the SVG. */
function mermaidBody(text: string): string {
  return `<pre class="mermaid" style="margin:0;background:none;border:0;text-align:center">${escapeText(text)}</pre>`
    + '<script>(function(){var m=window.mermaid;if(!m){console.error("Mermaid did not load");return;}'
    + 'm.initialize({startOnLoad:false,securityLevel:"strict",theme:"dark"});'
    // Text is measured while drawing: a frame in a hidden tab measures nothing, so it waits until it is seen.
    + 'var go=function(){m.run({querySelector:"pre.mermaid"}).catch(function(e){console.error("Diagram: "+(e&&e.message||e));});};'
    + 'if(document.visibilityState!=="hidden")go();else document.addEventListener("visibilitychange",function h(){'
    + 'if(document.visibilityState!=="hidden"){document.removeEventListener("visibilitychange",h);go();}});})();</script>';
}

export function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function attr(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;');
}

/** JSON inside a <script> element: `<` escaped so no string can close the element. */
export function scriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * The frame's design kit: a snippet that writes plain markup already looks like Alfred, and a few classes (`.grid`,
 * `.card`, `.kpi`, `.badge`, `.bar`, `table`) give a dashboard without any CSS of its own. Every rule is wrapped in
 * :where() - no specificity - so the snippet's own styles always win.
 */
const BASE_CSS = 'html{color-scheme:dark}'
  + ':root{--k-text:var(--text,#e5e9f5);--k-dim:var(--text-dim,#a3acc9);--k-faint:var(--text-faint,#6b7394);'
  + '--k-panel:color-mix(in srgb,var(--card-inner,#1b2150) 70%,transparent);--k-line:var(--border,#2c3466);'
  + '--k-accent:var(--purple-light,#c4b5fd);--k-ok:var(--green,#34d399);--k-err:var(--red,#f87171);--k-warn:var(--amber,#fbbf24);'
  + '--k-info:var(--blue,#60a5fa);--k-radius:10px;--k-font:"Inter","Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,Roboto,sans-serif;'
  + '--k-mono:ui-monospace,"Cascadia Code",Consolas,monospace}'
  + ':where(body){margin:0;padding:12px;color:var(--k-text);background:transparent;font:13.5px/1.55 var(--k-font);'
  + 'overflow-wrap:anywhere;-webkit-font-smoothing:antialiased}'
  + ':where(*,*::before,*::after){box-sizing:border-box}'
  + ':where(h1,h2,h3,h4){margin:0 0 .5em;line-height:1.25;font-weight:650;letter-spacing:-.01em}'
  + ':where(h1){font-size:20px}:where(h2){font-size:16px}:where(h3){font-size:14px}:where(h4){font-size:13px;color:var(--k-dim)}'
  + ':where(p){margin:0 0 .6em}:where(a){color:var(--k-accent)}:where(small,.muted){color:var(--k-dim)}:where(.faint){color:var(--k-faint)}'
  + ':where(code,pre,kbd){font-family:var(--k-mono);font-size:.92em}'
  + ':where(pre){background:var(--k-panel);border:1px solid var(--k-line);border-radius:8px;padding:10px;overflow:auto}'
  + ':where(hr){border:0;border-top:1px solid var(--k-line);margin:12px 0}'
  // tables: full width, a sticky header, quiet rows, numbers right-aligned in .num
  + ':where(table){border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}'
  + ':where(th,td){padding:6px 10px;border-bottom:1px solid var(--k-line);text-align:start;vertical-align:top}'
  + ':where(th){position:sticky;top:0;background:var(--popover-solid,#141a45);color:var(--k-dim);font-weight:600;font-size:12px;'
  + 'text-transform:uppercase;letter-spacing:.04em}'
  + ':where(tbody tr:hover){background:color-mix(in srgb,var(--k-accent) 7%,transparent)}'
  + ':where(.num,td.num,th.num){text-align:end;font-variant-numeric:tabular-nums}'
  + ':where(.table-wrap){max-height:420px;overflow:auto;border:1px solid var(--k-line);border-radius:var(--k-radius)}'
  // layout
  + ':where(.grid){display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(var(--min,170px),1fr))}'
  + ':where(.row){display:flex;gap:12px;align-items:center;flex-wrap:wrap}:where(.stack){display:flex;flex-direction:column;gap:12px}'
  + ':where(.spacer){flex:1}'
  + ':where(.card){background:var(--k-panel);border:1px solid var(--k-line);border-radius:var(--k-radius);padding:14px 16px}'
  + ':where(.card>h3:first-child,.card>h4:first-child){margin-bottom:10px}'
  // numbers that matter
  + ':where(.kpi){display:flex;flex-direction:column;gap:2px}'
  + ':where(.kpi .label){color:var(--k-dim);font-size:12px;text-transform:uppercase;letter-spacing:.05em}'
  + ':where(.kpi .value){font-size:28px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.15}'
  + ':where(.kpi .note){color:var(--k-faint);font-size:12px}'
  + ':where(.up){color:var(--k-ok)}:where(.down,.err){color:var(--k-err)}:where(.warn){color:var(--k-warn)}:where(.ok){color:var(--k-ok)}'
  // badges: .badge.ok / .warn / .err / .info, or a method/status pill
  + ':where(.badge){display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;font-size:11.5px;font-weight:600;'
  + 'background:color-mix(in srgb,currentColor 14%,transparent);color:var(--k-dim);white-space:nowrap}'
  + ':where(.badge.ok){color:var(--k-ok)}:where(.badge.warn){color:var(--k-warn)}:where(.badge.err){color:var(--k-err)}:where(.badge.info){color:var(--k-info)}'
  // an inline bar: <div class="bar" style="--v:.42"></div> (0..1), .bar.err / .warn / .ok
  + ':where(.bar){height:8px;border-radius:99px;background:color-mix(in srgb,var(--k-line) 70%,transparent);overflow:hidden;min-width:60px}'
  + ':where(.bar)::after{content:"";display:block;height:100%;width:calc(var(--v,0)*100%);border-radius:inherit;background:var(--c,var(--k-accent))}'
  + ':where(.bar.err){--c:var(--k-err)}:where(.bar.warn){--c:var(--k-warn)}:where(.bar.ok){--c:var(--k-ok)}'
  // a chart's box: echarts/apex need a height
  + ':where(.chart){width:100%;height:var(--h,320px)}'
  // controls
  + ':where(button,select,input,textarea){font:inherit;color:inherit;background:var(--k-panel);border:1px solid var(--k-line);border-radius:8px;padding:5px 10px}'
  + ':where(button){cursor:pointer}:where(button:hover){border-color:var(--k-accent)}:where(button.primary){background:var(--k-accent);color:#120f2e;border-color:transparent;font-weight:600}'
  + ':where(.tabs){display:flex;gap:4px;border-bottom:1px solid var(--k-line);margin-bottom:10px}'
  + ':where(.tabs>button){border:0;border-bottom:2px solid transparent;border-radius:0;background:none;color:var(--k-dim)}'
  + ':where(.tabs>button.on,.tabs>button[aria-selected="true"]){color:var(--k-text);border-bottom-color:var(--k-accent)}'
  + ':where(svg text){fill:currentColor}'
  + ':where(*){scrollbar-width:thin;scrollbar-color:var(--k-line) transparent}';

/**
 * The colours of a series, in order - the same in every library (applied by the runtime to ECharts, Chart.js,
 * ApexCharts, Plotly, Observable Plot and Mermaid) and given to a snippet as `alfred.palette`.
 */
export const SNIPPET_PALETTE = ['#a78bfa', '#22d3ee', '#34d399', '#fbbf24', '#f472b6', '#60a5fa', '#fb923c', '#a3e635', '#f87171', '#2dd4bf'];

/**
 * A classic inline script that declares `top`, `name`, `status`… at its top level runs into the window's own globals:
 * `const top` is a SyntaxError (the snippet draws nothing), `var name = [..]` becomes a string. Such a script is put in a
 * block so its names are its own; functions it declares stay global (onclick="draw()" keeps working).
 */
const WINDOW_NAMES = 'top|window|document|location|name|status|parent|self|frames|length|origin|opener|closed|history|screen|event|'
  + 'external|performance|crypto|navigator|close|open|print|stop|focus|blur|find|alert|scroll|menubar|toolbar|personalbar|statusbar|scrollbars|locationbar';
const CLASHING_DECL = new RegExp(`\\b(?:var|let|const|class)\\s+(?:${WINDOW_NAMES})\\b`);
export function scopeClassicScripts(html: string): string {
  return html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (all, attrs: string, code: string) => {
    if (/\bsrc\s*=/i.test(attrs)) return all;
    const type = /\btype\s*=\s*(["']?)([^"'\s>]*)\1/i.exec(attrs)?.[2]?.toLowerCase() ?? '';
    if (type && type !== 'text/javascript' && type !== 'application/javascript') return all;
    if (!CLASHING_DECL.test(code)) return all;
    const own = code.replace(new RegExp(`\\bvar(\\s+(?:${WINDOW_NAMES})\\b)`, 'g'), 'let$1');
    return `<script${attrs}>{\n${own}\n}</script>`;
  });
}

/**
 * Run after the shelf's libraries load (and again when a snippet loads one with alfred.lib): each charting library
 * gets Alfred's dark theme and palette by default - a snippet that sets its own colours keeps them.
 */
const THEME_SCRIPT = 'window.__alfredTheme&&window.__alfredTheme();';

/** The theme variables the frame gets - read from the page so any theme carries over. */
export const THEME_VARS = ['--text', '--text-dim', '--text-faint', '--card', '--card-inner', '--bg-2', '--border', '--border-strong',
  '--purple', '--purple-light', '--green', '--red', '--amber', '--blue', '--cyan', '--popover-solid'];

export function themeVars(el: Element = document.documentElement): Record<string, string> {
  const cs = getComputedStyle(el);
  const out: Record<string, string> = {
    '--red': '#f87171', '--green': '#34d399', '--amber': '#fbbf24', '--blue': '#60a5fa', '--cyan': '#22d3ee',
  };
  for (const name of THEME_VARS) {
    const v = cs.getPropertyValue(name).trim();
    if (v) out[name] = v;
  }
  return out;
}

/**
 * `window.alfred` inside the frame (R11). It talks only to its parent and only by postMessage; every message carries
 * `alfred: 1`. A message from anything but the parent is ignored. Plain ES5-ish so any snippet can sit beside it.
 */
export const SNIPPET_RUNTIME = String.raw`(function(){
"use strict";
var P=window.parent, seq=0, wseq=0, pend={}, on={}, declared={}, paused=false, queued=[], sent=0, sentAt=0;
var boot={};try{boot=JSON.parse(document.getElementById("alfred-boot").textContent)}catch(e){}
var alone=(P===window);
var fileUrls={};
function mimeOf(n){return /\.m?js$/i.test(n)?"text/javascript":/\.css$/i.test(n)?"text/css":/\.svg$/i.test(n)?"image/svg+xml":/\.json$/i.test(n)?"application/json":"text/plain"}
if(boot.files){for(var fn in boot.files)fileUrls[fn]=URL.createObjectURL(new Blob([boot.files[fn]],{type:mimeOf(fn)}))}
if(boot.modules||boot.imports||boot.files){var im={},k;if(boot.imports)for(k in boot.imports)im[k]=boot.imports[k];
  if(boot.modules)for(k in boot.modules)im[k]=URL.createObjectURL(new Blob([boot.modules[k]],{type:"text/javascript"}));
  for(k in fileUrls)if(/\.m?js$/i.test(k))im["@file/"+k]=fileUrls[k];
  var ims=document.createElement("script");ims.type="importmap";ims.textContent=JSON.stringify({imports:im});document.head.appendChild(ims)}
if(boot.inline){(boot.inline.styles||[]).forEach(function(c){var st=document.createElement("style");st.textContent=c;document.head.appendChild(st)});
  (boot.inline.scripts||[]).forEach(function(c){document.write('<script src="'+URL.createObjectURL(new Blob([c],{type:"text/javascript"}))+'"><'+'/script>')})}
if(boot.files){for(var cn in boot.files)if(/\.css$/i.test(cn)){var fst=document.createElement("style");fst.textContent=boot.files[cn];document.head.appendChild(fst)}}
function fileRefs(){Array.prototype.forEach.call(document.querySelectorAll("[src^='./'],[href^='./']"),function(e){
  ["src","href"].forEach(function(a){var v=e.getAttribute(a);if(v&&v.slice(0,2)==="./"&&fileUrls[v.slice(2)])e.setAttribute(a,fileUrls[v.slice(2)])})})}
function post(m){m.alfred=1;if(alone)return;var t=Date.now();if(t-sentAt>1000){sentAt=t;sent=0}if(++sent>40&&m.t==="log")return;try{P.postMessage(m,"*")}catch(e){}}
function req(op,args){return new Promise(function(res,rej){
  if(alone||boot.offline){var s=boot.static,a=args||{};var k=staticKey(op,a);if(s&&Object.prototype.hasOwnProperty.call(s,k)){res(s[k])}
    else if(op==="state.set"){res(null)}else{rej(new Error("Not available outside Alfred: "+op+(op==="data"?" "+a.src:"")))}return}
  var id=++seq;pend[id]={res:res,rej:rej};post({t:"req",id:id,op:op,args:args===undefined?null:args})})}
function staticKey(op,a){return op==="data"?"data:"+JSON.stringify({src:a.src,args:a.args||{}}):op+":"+JSON.stringify(a)}
function emit(name,v){(on[name]||[]).slice().forEach(function(f){try{f(v)}catch(e){console.error(e)}})}
function text(a){try{if(typeof a==="string")return a;if(a instanceof Error)return a.stack||String(a);return JSON.stringify(a,null,1)}catch(e){return String(a)}}
["log","info","warn","error","debug"].forEach(function(l){var o=console[l];console[l]=function(){
  var s=Array.prototype.map.call(arguments,text).join(" ");if(s.length>4000)s=s.slice(0,4000)+"…";post({t:"log",level:l,text:s});
  try{o.apply(console,arguments)}catch(e){}}});
window.addEventListener("error",function(e){post({t:"log",level:"error",text:(e.message||"Error")+(e.lineno?" (line "+e.lineno+")":"")})});
window.addEventListener("unhandledrejection",function(e){post({t:"log",level:"error",text:"Unhandled: "+text(e.reason)})});
document.addEventListener("securitypolicyviolation",function(e){post({t:"log",level:"error",text:"Blocked "+(e.blockedURI||"")+
  " - snippets have no network: use Alfred's libraries (/lib/) and alfred.data()"})});
var raf=window.requestAnimationFrame.bind(window);
window.requestAnimationFrame=function(f){if(paused){queued.push(f);return 0}return raf(f)};
var style=null;
function pause(p){if(p===paused)return;paused=p;
  if(p){style=document.createElement("style");style.textContent="*,*::before,*::after{animation-play-state:paused!important}";document.head.appendChild(style);
    Array.prototype.forEach.call(document.querySelectorAll("video,audio"),function(m){if(!m.paused){m.dataset.alfredPaused="1";m.pause()}})}
  else{if(style)style.remove();style=null;var q=queued;queued=[];q.forEach(function(f){raf(f)});
    Array.prototype.forEach.call(document.querySelectorAll("[data-alfred-paused]"),function(m){delete m.dataset.alfredPaused;m.play()})}
  emit(p?"pause":"resume");window.dispatchEvent(new Event(p?"alfred:pause":"alfred:resume"))}
var lastH=0;
function size(){var b=document.body;if(!b)return;var h=Math.ceil(Math.max(b.scrollHeight,b.getBoundingClientRect().height));
  if(h!==lastH){lastH=h;post({t:"size",h:h})}}
function isModule(u){return /module|\.mjs$/.test(u)&&!/tailwind/.test(u)}
function addLib(u,module,css){return new Promise(function(res,rej){
  if(css){var l=document.createElement("link");l.rel="stylesheet";l.href=u;l.onload=function(){res()};l.onerror=rej;document.head.appendChild(l);return}
  if(module){import(u).then(res,rej);return}
  var s=document.createElement("script");s.src=u;s.onload=function(){res()};s.onerror=rej;document.head.appendChild(s)})}
function loadLib(id){var u=boot.libs&&boot.libs[id];if(!u)return Promise.reject(new Error("No library "+id));
  var css=/\.css$/.test(u),module=isModule(u);
  var viaHost=function(){return req("lib",{id:id}).then(function(code){
    if(css){var st=document.createElement("style");st.textContent=code;document.head.appendChild(st);return}
    return addLib(URL.createObjectURL(new Blob([code],{type:"text/javascript"})),module,false)})};
  var first=boot.direct?addLib(u,module,css):Promise.reject();
  return first.then(null,viaHost).then(function(v){themeLibs();return v},function(){throw new Error("Could not load "+id)})}
var PAL=boot.palette||["#a78bfa","#22d3ee","#34d399","#fbbf24","#f472b6","#60a5fa"];
function cssv(n,d){try{return getComputedStyle(document.documentElement).getPropertyValue(n).trim()||d}catch(e){return d}}
function tone(){return{text:cssv("--text","#e5e9f5"),dim:cssv("--text-dim","#a3acc9"),faint:cssv("--text-faint","#6b7394"),line:cssv("--border","#2c3466"),
  pop:cssv("--popover-solid","#141a45"),grid:"rgba(255,255,255,0.07)",font:'"Inter","Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,sans-serif'}}
function alpha(c,a){if(/^#[0-9a-f]{6}$/i.test(c)){var n=parseInt(c.slice(1),16);return"rgba("+(n>>16)+","+(n>>8&255)+","+(n&255)+","+a+")"}return c}
function merge(a,b){var o={},k;for(k in a)o[k]=a[k];for(k in b){var x=b[k];o[k]=x&&typeof x==="object"&&!Array.isArray(x)&&a[k]&&typeof a[k]==="object"?merge(a[k],x):x}return o}
var themed={};
// Each charting library on the page gets Alfred's dark theme and palette by default; a snippet's own colours win.
function themeLibs(){var t=tone(),W=window;
  if(W.echarts&&!themed.echarts){themed.echarts=1;try{var ax={axisLine:{lineStyle:{color:t.line}},axisTick:{lineStyle:{color:t.line}},axisLabel:{color:t.dim},
      splitLine:{lineStyle:{color:t.grid}},nameTextStyle:{color:t.dim}};
    W.echarts.registerTheme("alfred",{color:PAL,backgroundColor:"transparent",textStyle:{color:t.text,fontFamily:t.font},
      title:{textStyle:{color:t.text,fontWeight:600,fontSize:14},subtextStyle:{color:t.dim}},legend:{textStyle:{color:t.dim},inactiveColor:t.faint},
      tooltip:{backgroundColor:t.pop,borderColor:t.line,textStyle:{color:t.text}},categoryAxis:ax,valueAxis:ax,timeAxis:ax,logAxis:ax,
      bar:{itemStyle:{borderRadius:[4,4,0,0]}},line:{symbolSize:5},grid:{top:48,right:28,bottom:24,left:16,containLabel:true},dataZoom:{textStyle:{color:t.dim},borderColor:t.line}});
    var ei=W.echarts.init;W.echarts.init=function(el,th,o){var c=ei.call(W.echarts,el,th==null?"alfred":th,o);
      try{new ResizeObserver(function(){if(!c.isDisposed())c.resize()}).observe(el)}catch(e){}return c}}catch(e){}}
  if(W.Chart&&!themed.chart){themed.chart=1;try{var D=W.Chart.defaults,tt=D.plugins.tooltip;D.color=t.dim;D.borderColor=t.grid;D.font.family=t.font;D.font.size=12;
    tt.backgroundColor=t.pop;tt.borderColor=t.line;tt.borderWidth=1;tt.titleColor=t.text;tt.bodyColor=t.text;tt.padding=10;D.plugins.legend.labels.usePointStyle=true;
    if(D.elements&&D.elements.bar)D.elements.bar.borderRadius=4;
    W.Chart.register({id:"alfredPalette",beforeUpdate:function(ch){var cfg=ch.config,ds=(cfg.data&&cfg.data.datasets)||[];
      ds.forEach(function(d,i){if(d.backgroundColor!==undefined||d.borderColor!==undefined)return;var ty=d.type||cfg.type;
        if(/pie|doughnut|polarArea/.test(ty)){d.backgroundColor=(cfg.data.labels||[]).map(function(_,j){return PAL[j%PAL.length]});d.borderColor=t.pop;d.borderWidth=2}
        else{var c=PAL[i%PAL.length];d.borderColor=c;d.backgroundColor=/line|radar/.test(ty)?alpha(c,d.fill?0.18:1):alpha(c,0.85);
          if(/line/.test(ty)&&d.pointRadius===undefined)d.pointRadius=2}})}})}catch(e){}}
  if(W.ApexCharts&&!themed.apex){themed.apex=1;W.Apex=merge({theme:{mode:"dark"},colors:PAL,chart:{background:"transparent",foreColor:t.dim,fontFamily:t.font,toolbar:{show:false}},
    grid:{borderColor:t.grid},tooltip:{theme:"dark"},dataLabels:{enabled:false},stroke:{width:2}},W.Apex||{})}
  if(W.Plotly&&!themed.plotly){themed.plotly=1;try{var ax2={gridcolor:t.grid,zerolinecolor:t.line,linecolor:t.line},lay={paper_bgcolor:"rgba(0,0,0,0)",plot_bgcolor:"rgba(0,0,0,0)",
      font:{color:t.text,family:t.font,size:12},colorway:PAL,margin:{t:36,r:16,b:44,l:56},xaxis:ax2,yaxis:ax2,legend:{font:{color:t.dim}},
      hoverlabel:{bgcolor:t.pop,bordercolor:t.line,font:{color:t.text}}},cf={displaylogo:false,responsive:true};
    var lo=function(l){var o=merge(lay,l||{});for(var k in o)if(/^[xy]axis\d+$/.test(k))o[k]=merge(ax2,o[k]);return o};
    ["newPlot","react"].forEach(function(fn){var f=W.Plotly[fn];if(!f)return;W.Plotly[fn]=function(gd,data,layout,config){
      if(data&&typeof data==="object"&&!Array.isArray(data)){var o=merge({},data);o.layout=lo(o.layout);o.config=merge(cf,o.config||{});return f.call(W.Plotly,gd,o)}
      return f.call(W.Plotly,gd,data,lo(layout),merge(cf,config||{}))}})}catch(e){}}
  if(W.Plot&&!themed.plot){themed.plot=1;try{var pp=W.Plot.plot;W.Plot.plot=function(o){o=o||{};if(o.style===undefined)o=merge(o,{style:{background:"transparent",color:t.text,fontFamily:t.font,fontSize:"12px"}});
      if(o.color===undefined)o=merge(o,{color:{scheme:"observable10"}});return pp.call(W.Plot,o)}}catch(e){}}
  if(W.mermaid&&!themed.mermaid){themed.mermaid=1;try{var mi=W.mermaid.initialize,mv={darkMode:true,background:"transparent",primaryColor:"#2b2f6e",primaryBorderColor:PAL[0],
      primaryTextColor:t.text,secondaryColor:"#173847",tertiaryColor:"#1b2150",lineColor:t.dim,textColor:t.text,fontFamily:t.font,fontSize:"13px",
      noteBkgColor:"#3a3216",noteTextColor:t.text,noteBorderColor:"#fbbf24",clusterBkg:"rgba(167,139,250,0.06)",clusterBorder:t.line,edgeLabelBackground:t.pop,
      actorBkg:"#2b2f6e",actorBorder:PAL[0],actorTextColor:t.text,actorLineColor:t.line,signalColor:t.dim,signalTextColor:t.text,labelBoxBkgColor:"#2b2f6e",
      labelBoxBorderColor:PAL[0],labelTextColor:t.text,loopTextColor:t.text,activationBkgColor:"#3b3f86",sequenceNumberColor:"#120f2e",
      pie1:PAL[0],pie2:PAL[1],pie3:PAL[2],pie4:PAL[3],pie5:PAL[4],pie6:PAL[5],pie7:PAL[6],pie8:PAL[7],pieTitleTextColor:t.text,pieSectionTextColor:"#120f2e",pieLegendTextColor:t.text,
      cScale0:PAL[0],cScale1:PAL[1],cScale2:PAL[2],cScale3:PAL[3],cScale4:PAL[4],cScale5:PAL[5],git0:PAL[0],git1:PAL[1],git2:PAL[2],git3:PAL[3]};
    W.mermaid.initialize=function(c){c=c||{};var o=merge({},c);if(!o.theme||o.theme==="dark"||o.theme==="default"){o.theme="base";o.themeVariables=merge(mv,c.themeVariables||{})}
      return mi.call(W.mermaid,o)};
    W.mermaid.initialize({startOnLoad:true})}catch(e){}}}
window.__alfredTheme=themeLibs;
function fmtMs(v){v=Number(v);if(!isFinite(v))return"–";return v<1000?Math.round(v)+" ms":v<60000?(v/1000).toFixed(v<10000?2:1)+" s":Math.floor(v/60000)+" min "+Math.round(v%60000/1000)+" s"}
var fmt={ms:fmtMs,num:function(v,d){return Number(v).toLocaleString(undefined,{maximumFractionDigits:d==null?1:d})},
  pct:function(v,d){return(Number(v)*100).toFixed(d==null?0:d)+"%"},
  time:function(v){var x=new Date(v);return isNaN(x)?"–":x.toLocaleTimeString(undefined,{hour12:false})},
  bytes:function(v){v=Number(v);var u=["B","KB","MB","GB"],i=0;while(v>=1024&&i<3){v/=1024;i++}return(i?v.toFixed(1):v)+" "+u[i]},
  path:function(p,n){p=String(p==null?"":p).replace(/^https?:\/\/[^/]+/,"");n=n||48;return p.length>n?"…"+p.slice(p.length-n+1):p}};
function calls(a){var c=boot.context||{},o={limit:1000},k;if(c.cycleId&&c.card==null)o.cycle=c.cycleId;if(a)for(k in a)o[k]=a[k];
  return req("data",{src:"calls",args:o})}
var defaults={},blank=null;
function defaultsOf(tag){if(defaults[tag])return defaults[tag];var d={};try{if(!blank){var h=document.createElement("div");h.style.cssText="all:initial;position:absolute;width:0;height:0;overflow:hidden";document.documentElement.appendChild(h);blank=h.attachShadow({mode:"open"})}
  var e=document.createElement(tag);blank.appendChild(e);var cs=getComputedStyle(e);for(var i=0;i<cs.length;i++)d[cs[i]]=cs.getPropertyValue(cs[i]);blank.removeChild(e)}catch(x){}return defaults[tag]=d}
var INHERITED=/^(--|color|font|line-height|letter-spacing|word-spacing|text-(align|indent|transform|shadow|rendering|wrap|emphasis|underline)|white-space|direction|visibility|cursor|list-style|quotes|border-collapse|border-spacing|caption-side|empty-cells|tab-size|hyphens|word-break|overflow-wrap|writing-mode|color-scheme|-webkit-text|fill|stroke|paint-order|orphans|widows|image-rendering|pointer-events)/;
// Only what the copy would not get anyway - an inherited property that differs from the parent's, any other from the
// tag's default: the picture's style text is a fraction of every property of every element, and so is its drawing.
function copyStyle(src,dst,pcs){var cs=getComputedStyle(src),d=defaultsOf(src.tagName.toLowerCase()),t="";
  for(var i=0;i<cs.length;i++){var k=cs[i],v=cs.getPropertyValue(k),base=pcs&&INHERITED.test(k)?pcs.getPropertyValue(k):d[k];if(base!==v)t+=k+":"+v+";"}
  dst.setAttribute("style",t);return cs}
// A picture of the page as it ends up: entrance animations finished (an endless one never does - not waited for), then idle.
function settled(){var as=[];try{as=document.getAnimations().filter(function(a){var t=a.effect&&a.effect.getComputedTiming();return a.playState==="running"&&t&&isFinite(t.endTime)})}catch(x){}
  return Promise.race([Promise.all(as.map(function(a){return a.finished.then(null,function(){})})),new Promise(function(r){setTimeout(r,8000)})])
    .then(function(){return new Promise(function(r){(window.requestIdleCallback||function(f){setTimeout(f,30)})(function(){r()},{timeout:1000})})})}
function snap(n,pcs){if(n.nodeType===3)return document.createTextNode(n.nodeValue);if(n.nodeType!==1)return null;
  var tag=n.tagName.toLowerCase();if(/^(script|style|link|noscript|iframe|template)$/.test(tag))return null;
  var c;if(tag==="canvas"){c=document.createElement("img");try{c.setAttribute("src",n.toDataURL("image/png"))}catch(e){}}
  else{c=n.cloneNode(false);if(tag==="input"||tag==="textarea")c.setAttribute("value",n.value);if(tag==="video"||tag==="audio")return null}
  var cs=copyStyle(n,c,pcs);for(var ch=n.firstChild;ch;ch=ch.nextSibling){var x=snap(ch,cs);if(x)c.appendChild(x)}return c}
function shot(id,scale){sized(function(){settled().then(function(){draw(id,scale)})})}
function draw(id,scale){var fail=function(e){post({t:"shot",id:id,error:String(e&&e.message||e)})};try{var root=document.documentElement,body=document.body,rs=getComputedStyle(root),solid=rs.getPropertyValue("--popover-solid").trim()||"#141a45",bg=rs.getPropertyValue("--card").trim()||solid;
  var w=Math.max(1,Math.ceil(root.scrollWidth)),h=Math.max(1,Math.ceil(Math.max(body.scrollHeight,body.getBoundingClientRect().height)));
  var copy=snap(body);copy.style.margin="0";
  var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'"><foreignObject x="0" y="0" width="100%" height="100%">'+new XMLSerializer().serializeToString(copy)+"</foreignObject></svg>";
  var img=new Image();img.onload=function(){try{var k=scale>0?Math.min(2,scale):Math.min(2,window.devicePixelRatio||1)||1,c=document.createElement("canvas");c.width=Math.round(w*k);c.height=Math.round(h*k);
    var g=c.getContext("2d");g.scale(k,k);g.fillStyle=solid;g.fillRect(0,0,w,h);g.fillStyle=bg;g.fillRect(0,0,w,h);g.drawImage(img,0,0);post({t:"shot",id:id,png:c.toDataURL("image/png")})}
    catch(e){fail(e)}};
  img.onerror=function(){fail("The page could not be drawn")};
  img.src="data:image/svg+xml;charset=utf-8,"+encodeURIComponent(svg)}catch(e){fail(e)}}
window.addEventListener("message",function(e){if(e.source!==P)return;var m=e.data;if(!m||m.alfred!==1)return;
  if(m.t==="res"&&pend[m.id]){var p=pend[m.id];delete pend[m.id];if(m.ok)p.res(m.value);else p.rej(new Error(m.error||"Refused"))}
  else if(m.t==="pause")pause(true);else if(m.t==="resume")pause(false);else if(m.t==="shot")shot(m.id,typeof m.scale==="number"?m.scale:0);
  else if(m.t==="event"&&typeof m.name==="string")emit(m.name,m.value)});
var api={
  name:boot.name,dir:boot.dir,theme:"dark",vars:boot.vars,context:boot.context,card:boot.context&&boot.context.card,
  data:function(src,args){return req("data",{src:src,args:args||{}})},
  calls:calls,
  palette:PAL.slice(),
  colors:{accent:PAL[0],ok:cssv("--green","#34d399"),err:cssv("--red","#f87171"),warn:cssv("--amber","#fbbf24"),info:cssv("--blue","#60a5fa"),
    text:cssv("--text","#e5e9f5"),dim:cssv("--text-dim","#a3acc9"),line:cssv("--border","#2c3466")},
  fmt:fmt,
  watch:function(src,args,cb){var key="w"+(++wseq);if(typeof cb==="function")(on["data:"+key]=on["data:"+key]||[]).push(cb);
    return req("data",{src:src,args:args||{},live:key}).then(function(v){if(typeof cb==="function")try{cb(v)}catch(e){console.error(e)}return v})},
  value:function(name){var d=slot(name);return d.has?Promise.resolve(d.value):new Promise(function(r){d.waiters.push(r)})},
  on:function(n,f){(on[n]=on[n]||[]).push(f);return function(){on[n]=(on[n]||[]).filter(function(x){return x!==f})}},
  state:{get:function(k){return req("state.get",{key:k})},set:function(k,v){return req("state.set",{key:k,value:v})},all:function(){return req("state.all",{})}},
  action:function(kind,args){return req("action",{kind:kind,args:args||{}})},
  ask:function(q,data){return req("ask",{text:q,data:data===undefined?null:data})},
  files:function(name){return req("files",{name:name||null})},
  file:function(name){return boot.files&&Object.prototype.hasOwnProperty.call(boot.files,name)?boot.files[name]:null},
  url:function(name){return fileUrls[name]||null},
  lib:loadLib,
  resize:size,
  get paused(){return paused}
};
Object.freeze(api.state);window.alfred=Object.freeze(api);
function slot(name){return declared[name]=declared[name]||{has:false,value:undefined,waiters:[]}}
function loadDeclared(){Array.prototype.forEach.call(document.querySelectorAll('script[type="alfred/data"]'),function(s){
  var src=s.getAttribute("src")||"",name=s.getAttribute("name")||src,args={};
  try{args=s.textContent.trim()?JSON.parse(s.textContent):{}}catch(e){console.error("alfred/data "+name+": the text inside is the JSON arguments");return}
  var d=slot(name),got=function(v){d.has=true;d.value=v;var w=d.waiters;d.waiters=[];w.forEach(function(r){r(v)});emit(name,v)};
  var fail=function(e){console.error("alfred/data "+name+": "+(e&&e.message||e))};
  if(s.hasAttribute("live"))api.watch(src,args,got).catch(fail);else api.data(src,args).then(got,fail)})}
// A frame runs in its own process and may load before it is told its size: until then its window is 0 wide and the
// page measures 0 x 0 (a 1 x 1 picture, no height). Ready, and a picture, wait until it has one: a resize event, or
// the page's layout growing (the first size may come without a resize event).
function sized(f){if(window.innerWidth>0)return f();var done=false,ro=null,h=function(){if(done||!(window.innerWidth>0))return;done=true;removeEventListener("resize",h);if(ro)ro.disconnect();f()};
  addEventListener("resize",h);try{ro=new ResizeObserver(h);ro.observe(document.documentElement)}catch(e){}}
window.__alfredReady=function(){sized(function(){size();post({t:"ready"})})};
function start(){fileRefs();loadDeclared();try{new ResizeObserver(size).observe(document.body)}catch(e){}
  sized(function(){size();if(!boot.holdReady)post({t:"ready"})})}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);else start();
window.addEventListener("load",size);
})();`;

/** The key an offline frame looks an answer up by (the runtime's staticKey): `data:{"src":…,"args":…}`, else `op:{args}`. */
export function staticAnswerKey(op: string, args: Record<string, unknown>): string {
  return op === 'data' ? 'data:' + JSON.stringify({ src: args['src'], args: args['args'] ?? {} }) : op + ':' + JSON.stringify(args);
}

/** `<script type="alfred/data" src="calls" …>{args}</script>` blocks a snippet declares - what an export can answer ahead. */
export function declaredData(source: string): { src: string; args: Record<string, unknown> }[] {
  const out: { src: string; args: Record<string, unknown> }[] = [];
  for (const m of source.matchAll(/<script\b[^>]*\btype=(["'])alfred\/data\1[^>]*>([\s\S]*?)<\/script>/gi)) {
    const src = /\bsrc=(["'])([^"']+)\1/i.exec(m[0])?.[2];
    if (!src) continue;
    try {
      out.push({ src, args: m[2].trim() ? JSON.parse(m[2]) as Record<string, unknown> : {} });
    } catch { /* the frame says so when it runs */ }
  }
  return out;
}
