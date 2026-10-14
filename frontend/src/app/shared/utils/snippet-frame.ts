import { SnippetLib, SNIPPET_LIBS, importMap, libsOf } from './snippet-libs';

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

/** No network: inline code, /lib/ and Alfred's own pictures only. */
export function snippetCsp(origin: string): string {
  const lib = `${origin}/lib/`;
  return [
    `default-src 'none'`,
    `script-src 'unsafe-inline' 'unsafe-eval' blob: ${lib}`,
    `style-src 'unsafe-inline' ${lib}`,
    `img-src data: blob: ${lib} ${origin}/board/images/`,
    `font-src data: ${lib}`,
    `media-src data: blob:`,
    `worker-src blob:`,
    `connect-src 'none'`,
    `frame-src 'none'`,
    `form-action 'none'`,
    `base-uri 'none'`,
  ].join('; ');
}

export interface SnippetDocOptions {
  /** The snippet: HTML, or a diagram/program source when kind says so. */
  readonly source: string;
  readonly kind?: 'html' | 'mermaid';
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

/** The whole document for the frame's srcdoc - and, unchanged, the ⬇ .html download. */
export function buildSnippetDoc(o: SnippetDocOptions): string {
  const libs = libsForDoc(o);
  const body = o.kind === 'mermaid' ? mermaidBody(o.source) : stripDoctype(o.source);
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
    static: o.staticAnswers ?? null,
    direct: !inline,
    modules,
    // Scripts and styles as data, written into the page by the runtime: library code is never parsed as HTML.
    inline: inline ? {
      scripts: libs.filter((l) => (l.kind === 'script' || (l.kind === 'module' && l.provides === '(styles)')) && inline[l.file] !== undefined).map((l) => inline[l.file]),
      styles: libs.filter((l) => l.kind === 'css' && inline[l.file] !== undefined).map((l) => inline[l.file]),
    } : null,
  };
  const vars = Object.entries(safeVars).map(([k, v]) => `${k}:${v}`).join(';');
  return '<!doctype html><html' + (o.dir && o.dir !== 'auto' ? ` dir="${o.dir}"` : '') + '><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${attr(snippetCsp(o.origin))}">`
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + (inline ? '' : `<script type="importmap">${scriptJson({ imports: importMap(o.origin) })}</script>`)
    + `<style>:root{${vars}}${BASE_CSS}</style>`
    + `<script type="application/json" id="alfred-boot">${scriptJson(boot)}</script>`
    + `<script>${SNIPPET_RUNTIME}</script>`
    + (inline ? '' : libs.map((l) => libTag(l, o.origin)).join(''))
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

const BASE_CSS = 'html{color-scheme:dark}'
  + 'body{margin:0;padding:10px;color:var(--text,#e5e9f5);background:transparent;'
  + 'font:13px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow-wrap:anywhere}'
  + 'a{color:var(--purple-light,#c4b5fd)}'
  + 'table{border-collapse:collapse}td,th{border:1px solid var(--border,#333);padding:3px 8px}'
  + 'code,pre{font-family:ui-monospace,Consolas,monospace}';

/** The theme variables the frame gets - read from the page so any theme carries over. */
export const THEME_VARS = ['--text', '--text-dim', '--text-faint', '--card', '--card-inner', '--bg-2', '--border', '--border-strong',
  '--purple', '--purple-light', '--green', '--red', '--amber', '--blue', '--cyan'];

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
var P=window.parent, seq=0, pend={}, on={}, paused=false, queued=[], sent=0, sentAt=0;
var boot={};try{boot=JSON.parse(document.getElementById("alfred-boot").textContent)}catch(e){}
var alone=(P===window);
if(boot.modules){var im={};for(var k in boot.modules){im[k]=URL.createObjectURL(new Blob([boot.modules[k]],{type:"text/javascript"}))}
  var ims=document.createElement("script");ims.type="importmap";ims.textContent=JSON.stringify({imports:im});document.head.appendChild(ims)}
if(boot.inline){(boot.inline.styles||[]).forEach(function(c){var st=document.createElement("style");st.textContent=c;document.head.appendChild(st)});
  (boot.inline.scripts||[]).forEach(function(c){document.write('<script src="'+URL.createObjectURL(new Blob([c],{type:"text/javascript"}))+'"><'+'/script>')})}
function post(m){m.alfred=1;if(alone)return;var t=Date.now();if(t-sentAt>1000){sentAt=t;sent=0}if(++sent>40&&m.t==="log")return;try{P.postMessage(m,"*")}catch(e){}}
function req(op,args){return new Promise(function(res,rej){
  if(alone){var s=boot.static;var k=op+":"+JSON.stringify(args||{});if(s&&Object.prototype.hasOwnProperty.call(s,k)){res(s[k])}else{rej(new Error("Not available outside Alfred: "+op))}return}
  var id=++seq;pend[id]={res:res,rej:rej};post({t:"req",id:id,op:op,args:args===undefined?null:args})})}
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
  return first.then(null,viaHost).then(null,function(){throw new Error("Could not load "+id)})}
function copyStyle(src,dst){var cs=getComputedStyle(src),t="";for(var i=0;i<cs.length;i++){var k=cs[i];t+=k+":"+cs.getPropertyValue(k)+";"}dst.setAttribute("style",t)}
function snap(n){if(n.nodeType===3)return document.createTextNode(n.nodeValue);if(n.nodeType!==1)return null;
  var tag=n.tagName.toLowerCase();if(/^(script|style|link|noscript|iframe|template)$/.test(tag))return null;
  var c;if(tag==="canvas"){c=document.createElement("img");try{c.setAttribute("src",n.toDataURL("image/png"))}catch(e){}}
  else{c=n.cloneNode(false);if(tag==="input"||tag==="textarea")c.setAttribute("value",n.value);if(tag==="video"||tag==="audio")return null}
  copyStyle(n,c);for(var ch=n.firstChild;ch;ch=ch.nextSibling){var x=snap(ch);if(x)c.appendChild(x)}return c}
function shot(id){try{var root=document.documentElement,body=document.body,bg=getComputedStyle(root).getPropertyValue("--card").trim()||"#141a45";
  var w=Math.max(1,Math.ceil(root.scrollWidth)),h=Math.max(1,Math.ceil(Math.max(body.scrollHeight,body.getBoundingClientRect().height)));
  var copy=snap(body);copy.style.margin="0";
  var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'"><foreignObject x="0" y="0" width="100%" height="100%">'+new XMLSerializer().serializeToString(copy)+"</foreignObject></svg>";
  var img=new Image();img.onload=function(){try{var k=Math.min(2,window.devicePixelRatio||1)||1,c=document.createElement("canvas");c.width=w*k;c.height=h*k;
    var g=c.getContext("2d");g.scale(k,k);g.fillStyle=bg;g.fillRect(0,0,w,h);g.drawImage(img,0,0);post({t:"shot",id:id,png:c.toDataURL("image/png")})}
    catch(e){post({t:"shot",id:id,error:String(e&&e.message||e)})}};
  img.onerror=function(){post({t:"shot",id:id,error:"The page could not be drawn"})};
  img.src="data:image/svg+xml;charset=utf-8,"+encodeURIComponent(svg)}catch(e){post({t:"shot",id:id,error:String(e&&e.message||e)})}}
window.addEventListener("message",function(e){if(e.source!==P)return;var m=e.data;if(!m||m.alfred!==1)return;
  if(m.t==="res"&&pend[m.id]){var p=pend[m.id];delete pend[m.id];if(m.ok)p.res(m.value);else p.rej(new Error(m.error||"Refused"))}
  else if(m.t==="pause")pause(true);else if(m.t==="resume")pause(false);else if(m.t==="shot")shot(m.id);
  else if(m.t==="event"&&typeof m.name==="string")emit(m.name,m.value)});
var api={
  name:boot.name,dir:boot.dir,theme:"dark",vars:boot.vars,context:boot.context,card:boot.context&&boot.context.card,
  data:function(src,args){return req("data",{src:src,args:args||{}})},
  on:function(n,f){(on[n]=on[n]||[]).push(f);return function(){on[n]=(on[n]||[]).filter(function(x){return x!==f})}},
  state:{get:function(k){return req("state.get",{key:k})},set:function(k,v){return req("state.set",{key:k,value:v})},all:function(){return req("state.all",{})}},
  action:function(kind,args){return req("action",{kind:kind,args:args||{}})},
  ask:function(q,data){return req("ask",{text:q,data:data===undefined?null:data})},
  files:function(name){return req("files",{name:name||null})},
  lib:loadLib,
  resize:size,
  get paused(){return paused}
};
Object.freeze(api.state);window.alfred=Object.freeze(api);
function start(){size();try{new ResizeObserver(size).observe(document.body)}catch(e){}post({t:"ready"})}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);else start();
window.addEventListener("load",size);
})();`;
