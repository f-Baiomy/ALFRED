// Puts Python (Pyodide) on Alfred's library shelf for ```python live``` snippets (specs/017 R27): public/lib/pyodide/<major>/,
// served at /lib/pyodide/<major>/ like every other library - a snippet never loads anything from the internet.
//
// The core (pyodide.js, the wasm, the standard library) comes from the `pyodide` npm package, pinned in package.json
// and checked by npm. The packages a snippet may import (numpy, pandas, matplotlib and what they need) are not in npm:
// they are downloaded once from the Pyodide release on jsDelivr and each one is checked against the sha256 that the
// pinned pyodide-lock.json gives - a file that does not match is deleted and the build says so.
//
// Run before `ng build` (npm prebuild). Already there and matching = nothing is downloaded. Without a network the build
// still succeeds: Python snippets then say Python is not installed on this Alfred.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const core = dirname(require.resolve('pyodide/package.json'));
const version = JSON.parse(readFileSync(join(core, 'package.json'), 'utf8')).version;
const major = version.split('.').slice(0, 2).join('.');
const target = join(process.cwd(), 'public', 'lib', 'pyodide', major);
const CORE_FILES = ['pyodide.js', 'pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];
const WANTED = (process.env.ALFRED_PYODIDE_PACKAGES ?? 'numpy pandas matplotlib').split(/[\s,]+/).filter(Boolean);
const CDN = `https://cdn.jsdelivr.net/pyodide/v${version}/full/`;

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

mkdirSync(target, { recursive: true });
for (const f of CORE_FILES) {
  const from = join(core, f);
  const to = join(target, f);
  if (!existsSync(to) || sha256(to) !== sha256(from)) copyFileSync(from, to);
}

const lock = JSON.parse(readFileSync(join(core, 'pyodide-lock.json'), 'utf8'));
const needed = new Set();
const queue = [...WANTED];
while (queue.length) {
  const name = queue.shift();
  if (needed.has(name)) continue;
  const pkg = lock.packages[name];
  if (!pkg) { console.warn(`fetch-pyodide: no package "${name}" in Pyodide ${version}`); continue; }
  needed.add(name);
  queue.push(...pkg.depends);
}

let fetched = 0;
let failed = 0;
for (const name of needed) {
  const { file_name: file, sha256: want } = lock.packages[name];
  const to = join(target, file);
  if (existsSync(to) && sha256(to) === want) continue;
  try {
    const res = await fetch(CDN + file);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const got = createHash('sha256').update(bytes).digest('hex');
    if (got !== want) throw new Error(`sha256 ${got} is not the ${want} the lock file gives`);
    writeFileSync(to, bytes);
    fetched++;
  } catch (e) {
    failed++;
    rmSync(to, { force: true });
    console.warn(`fetch-pyodide: ${file} not fetched (${e.message})`);
  }
}
writeFileSync(join(target, 'alfred-packages.json'), JSON.stringify({ version, packages: [...needed].filter((n) => existsSync(join(target, lock.packages[n].file_name))) }, null, 1));
console.log(`fetch-pyodide: Pyodide ${version} in public/lib/pyodide/${major} - ${needed.size - failed} packages ready${fetched ? `, ${fetched} downloaded` : ''}${failed ? `, ${failed} missing (Python snippets importing them will say so)` : ''}`);
