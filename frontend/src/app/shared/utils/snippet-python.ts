/**
 * ```python live``` (specs/017 R27): Python 3.12 (Pyodide) in the same locked frame as any snippet, from Alfred's own
 * shelf at /lib/pyodide/<major>/ - fetched and checksummed when Alfred is built (frontend/scripts/fetch-pyodide.mjs).
 * The frame may read only that folder (connect-src), which is how Pyodide loads its core and packages; nothing else.
 *
 * In Python, `alfred` reads Alfred's data like a snippet does: `await alfred.calls(since="fix")` is a pandas DataFrame,
 * `await alfred.data("statements", call=…)` any allowed source, `alfred.file("rows.csv")` a file of a multi-file snippet.
 * The last expression is shown (a DataFrame as its table), print() goes to the console (stderr as warnings - an exception
 * is the error), and each matplotlib figure
 * is drawn as a picture.
 */

/** Where the shelf keeps Python, under /lib/. Must match the major version fetch-pyodide.mjs puts there. */
export const PYODIDE_DIR = 'pyodide/0.27';

/** Run before the snippet: the `alfred` object and how a value is shown. */
export const PYTHON_PRELUDE = String.raw`
import os, sys
os.environ.setdefault("MPLBACKEND", "AGG")
import js
from pyodide.ffi import to_js

def _alfred_js(v):
    return to_js(v, dict_converter=js.Object.fromEntries)

def _alfred_py(v):
    return v.to_py() if hasattr(v, "to_py") else v

class _Alfred:
    """Alfred's data, read through the snippet's bridge (the same allowlist as alfred.data in JavaScript)."""
    context = _alfred_py(js.alfred.context)

    async def data(self, src, **args):
        return _alfred_py(await js.alfred.data(src, _alfred_js(args)))

    async def frame(self, src, **args):
        import pandas as pd
        return pd.DataFrame(await self.data(src, **args))

    async def calls(self, **args):
        return await self.frame("calls", **args)

    def file(self, name):
        return js.alfred.file(name)

    async def files(self, name=None):
        return _alfred_py(await js.alfred.files(name))

    def show(self, value):
        _alfred_display(value)

alfred = _Alfred()

def _alfred_display(v):
    if v is None:
        return
    html = getattr(v, "_repr_html_", None)
    if callable(html):
        js._alfredShow(html(), True)
    else:
        js._alfredShow(v if isinstance(v, str) else repr(v), False)
`;

/** Run after it: the last value, then every matplotlib figure as a picture. */
export const PYTHON_EPILOGUE = String.raw`
_alfred_display(_alfred_last)
if "matplotlib.pyplot" in sys.modules:
    import matplotlib.pyplot as _plt, io as _io, base64 as _b64
    for _n in _plt.get_fignums():
        _buf = _io.BytesIO()
        _plt.figure(_n).savefig(_buf, format="png", dpi=100, bbox_inches="tight")
        js._alfredFigure(_b64.b64encode(_buf.getvalue()).decode())
    _plt.close("all")
`;

/** The page body of a Python snippet: where its output goes, its source as data, and the runner. */
export function pythonBody(source: string, origin: string, json: (v: unknown) => string): string {
  const base = `${origin}/lib/${PYODIDE_DIR}/`;
  return '<div id="py-status" class="py-status">Starting Python…</div><div id="py-out"></div>'
    + `<script type="application/json" id="py-src">${json({ source, prelude: PYTHON_PRELUDE, epilogue: PYTHON_EPILOGUE, base })}</script>`
    + `<script src="${base}pyodide.js"></script>`
    + `<script>${PYTHON_RUNNER}</script>`;
}

/** Loads Pyodide, the packages the source imports, runs it; says ready when done so the picture shows the result. */
const PYTHON_RUNNER = String.raw`(function(){
var cfg=JSON.parse(document.getElementById("py-src").textContent),out=document.getElementById("py-out"),status=document.getElementById("py-status");
function done(){if(status&&status.parentNode)status.parentNode.removeChild(status);if(window.__alfredReady)window.__alfredReady()}
function fail(m){console.error(m);status.textContent="";done()}
window._alfredShow=function(v,isHtml){var d=document.createElement(isHtml?"div":"pre");d.className=isHtml?"py-html":"py-text";if(isHtml)d.innerHTML=v;else d.textContent=v;out.appendChild(d)};
window._alfredFigure=function(b64){var i=document.createElement("img");i.className="py-figure";i.alt="figure";i.src="data:image/png;base64,"+b64;out.appendChild(i)};
// Not ready, ever: no picture is kept of a frame that could not run Python - another viewer's will be.
if(typeof loadPyodide!=="function"){console.error("Python is not on this Alfred's shelf (it is fetched when Alfred is built) - or this browser keeps the locked frame from reading it.");status.textContent="";return}
(async function(){
  try{
    var py=await loadPyodide({indexURL:cfg.base,stdout:function(s){console.log(s)},stderr:function(s){console.warn(s)}});
    status.textContent="Loading packages…";
    var quiet={messageCallback:function(){},errorCallback:function(m){console.error(m)}};
    await py.loadPackagesFromImports(cfg.source,quiet);
    if(/alfred\.(calls|frame)\(/.test(cfg.source))await py.loadPackage(["pandas"],quiet);
    status.textContent="Running…";
    await py.runPythonAsync(cfg.prelude);
    var last=await py.runPythonAsync(cfg.source);
    py.globals.set("_alfred_last",last===undefined?null:last);
    await py.runPythonAsync(cfg.epilogue);
    if(last&&typeof last.destroy==="function")last.destroy();
    done();
  }catch(e){fail(String(e&&e.message||e))}
})();
})();`;

export const PYTHON_CSS = '.py-status{color:var(--text-dim,#93a0c2);font-style:italic}.py-text{white-space:pre-wrap;margin:4px 0}'
  + '.py-figure{max-width:100%;display:block;margin:6px 0;background:#fff;border-radius:4px}.py-html{overflow:auto;margin:4px 0}'
  + '.py-html table{font-size:12px}';
