import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { session } from './session.ts';

/**
 * Turns a db-agent call-chain frame - `GenericDAOImpl.fetchWithHQL(GenericDAOImpl.java:468)`, simple
 * class name only, no package - into the file in the project Claude is working in, so it can open
 * `src/main/java/.../GenericDAOImpl.java:468` directly instead of searching for it. The server runs
 * in that project's folder (Claude Code starts it there), so it indexes the source files under it
 * once, by file name, and answers from the index.
 */

const SOURCE_FILE = /\.(java|kt|groovy|scala)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'build', 'out', 'dist', 'bin', '.idea', '.gradle', '.mvn', '.settings', 'tmp']);
const MAX_FILES = 300_000;
/** A miss rebuilds the index, but not more often than this - a frame from a library is a miss every time. */
const REBUILD_AFTER_MISS_MS = 30_000;

interface SourceIndex {
  readonly root: string;
  readonly byName: Map<string, string[]>;
  readonly builtAt: number;
  readonly truncated: boolean;
}

let cached: Promise<SourceIndex> | null = null;

async function build(root: string): Promise<SourceIndex> {
  const byName = new Map<string, string[]>();
  let files = 0;
  let truncated = false;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable folder: skipped, like an IDE would
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) stack.push(join(dir, entry.name));
      } else if (SOURCE_FILE.test(entry.name)) {
        if (++files > MAX_FILES) { truncated = true; stack.length = 0; break; }
        const rel = relative(root, join(dir, entry.name)).split(sep).join('/');
        byName.set(entry.name, [...(byName.get(entry.name) ?? []), rel]);
      }
    }
  }
  return { root, byName, builtAt: Date.now(), truncated };
}

async function index(rebuildIfOlderThan?: number): Promise<SourceIndex> {
  const root = session.sourceRoot;
  let current = cached ? await cached : null;
  if (!current || current.root !== root || (rebuildIfOlderThan !== undefined && Date.now() - current.builtAt > rebuildIfOlderThan)) {
    cached = build(root);
    current = await cached;
  }
  return current;
}

export interface ParsedFrame {
  readonly className: string;
  readonly method: string;
  readonly file: string | null;
  readonly line: number | null;
}

/** `Class.method(File.java:12)`; the class may carry a package and `$Inner`, the file may be "Unknown Source". */
export function parseFrame(frame: string): ParsedFrame | null {
  const m = /^(.+)\.([^.(]+)\(([^:()]*)(?::(\d+))?\)$/.exec(frame.trim());
  if (!m) return null;
  return { className: m[1], method: m[2], file: SOURCE_FILE.test(m[3]) ? m[3] : null, line: m[4] ? Number(m[4]) : null };
}

export interface ResolvedFrame {
  readonly frame: string;
  /** `path/in/project/File.java:line`, when exactly one file matches. */
  readonly source?: string;
  /** Several files of that name: all of them, best guess first. */
  readonly candidates?: string[];
}

function rank(paths: readonly string[], className: string): string[] {
  // A packaged class name (com.tt.nc.Foo) points at its own folder; prefer main sources over tests.
  const pkgPath = className.includes('.') ? className.replace(/\$.*$/, '').split('.').slice(0, -1).join('/') : '';
  const score = (p: string) => (pkgPath && p.includes(pkgPath) ? 0 : 2) + (/(^|\/)src\/test\//.test(p) ? 1 : 0);
  return [...paths].sort((x, y) => score(x) - score(y) || x.length - y.length);
}

/** File contents by path, kept while the file's modified time is unchanged - the user edits these files while debugging. */
const fileLines = new Map<string, { mtimeMs: number; lines: Promise<string[] | null> }>();

async function linesOf(root: string, path: string): Promise<string[] | null> {
  const full = join(root, path);
  const info = await stat(full).catch(() => null);
  if (!info) return null;
  const cachedFile = fileLines.get(full);
  if (cachedFile && cachedFile.mtimeMs === info.mtimeMs) return cachedFile.lines;
  const lines = readFile(full, 'utf8').then((text) => text.split(/\r?\n/), () => null);
  fileLines.set(full, { mtimeMs: info.mtimeMs, lines });
  return lines;
}

/** A line that declares a method or constructor - not a call, a control statement or a field. */
const DECLARATION = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|protected|private|static|final|synchronized|abstract|native|default|strictfp)\s+)*(?:<[^>]+>\s+)?(?:[\w$.<>?,\[\]\s]+\s+)?([\w$]+)\s*\(/;
const NOT_A_DECLARATION = /^\s*(?:return|new|if|else|for|while|switch|catch|throw|do|try|case|assert|synchronized\s*\()\b/;
const SCAN_BACK_LINES = 600;

/**
 * Whether `path` is the file a frame ran in: it has that line, and the method declared nearest above
 * the line is the frame's method. Two classes of one name in different packages (odeysys has two
 * GenericDAOImpl.java) are told apart this way, since a frame carries no package. A lambda frame
 * (lambda$save$2) checks its enclosing method; a constructor frame cannot be checked and passes.
 */
async function confirms(root: string, path: string, method: string, line: number): Promise<boolean> {
  const lines = await linesOf(root, path);
  if (!lines || line > lines.length) return false;
  if (method.startsWith('<')) return true;
  const name = method.startsWith('lambda$') ? method.split('$')[1] : method;
  for (let i = line - 1; i >= Math.max(0, line - 1 - SCAN_BACK_LINES); i--) {
    const text = lines[i];
    if (NOT_A_DECLARATION.test(text) || !/\)\s*(?:throws\b[^{;]*)?\{?\s*$|\(\s*$|,\s*$/.test(text)) continue;
    const decl = DECLARATION.exec(text);
    if (decl) return decl[1] === name;
  }
  return true;
}

/** The Java package a source path is in, from its folders after the source root (src/main/java/com/tt/Foo.java → com.tt). */
function packageOf(path: string): string {
  const m = /(?:^|\/)src\/(?:main|test)\/(?:java|kotlin|groovy|scala)\/(.+)\/[^/]+$/.exec(path);
  return m ? m[1].replace(/\//g, '.') : '';
}

/**
 * For a chain (innermost frame first), a frame still ambiguous after the method check is settled by
 * the frame that called it: the caller's file imports one specific class of that name, or - with no
 * import - uses the one in its own package. Odeysys has two GenericDAOImpl with a fetchWithHQL at
 * line 468; OrganizationDaoImpl imports com.tt.nc.core.dao.GenericDAOImpl.
 */
async function settleByCaller(root: string, resolved: ResolvedFrame[], parsed: readonly { p: ParsedFrame | null }[]): Promise<ResolvedFrame[]> {
  const out = [...resolved];
  for (let i = 0; i < out.length - 1; i++) {
    const here = out[i];
    const caller = out[i + 1];
    const cls = parsed[i].p?.className.split('.').pop()?.replace(/\$.*$/, '');
    if (!here.candidates || !caller.source || !cls) continue;
    const callerPath = caller.source.replace(/:\d+$/, '');
    const lines = await linesOf(root, callerPath);
    if (!lines) continue;
    const imported = lines.map((l) => new RegExp(`^\\s*import\\s+([\\w.]+)\\.${cls.replace(/\$/g, '\\$')}\\s*;`).exec(l)?.[1]).find(Boolean);
    const pkg = imported ?? packageOf(callerPath);
    const match = here.candidates.filter((c) => packageOf(c.replace(/:\d+$/, '')) === pkg);
    if (match.length === 1) out[i] = { frame: here.frame, source: match[0] };
  }
  return out;
}

export async function resolveFrames(frames: readonly string[]): Promise<ResolvedFrame[]> {
  if (!frames.length) return [];
  let idx = await index();
  const parsed = frames.map((f) => ({ frame: f, p: parseFrame(f) }));
  if (parsed.some((x) => x.p?.file && !idx.byName.has(x.p.file))) idx = await index(REBUILD_AFTER_MISS_MS);
  const each = await resolveEach(idx, parsed);
  return settleByCaller(idx.root, each, parsed);
}

async function resolveEach(idx: SourceIndex, parsed: readonly { frame: string; p: ParsedFrame | null }[]): Promise<ResolvedFrame[]> {
  return Promise.all(parsed.map(async ({ frame, p }) => {
    const found = p?.file ? idx.byName.get(p.file) ?? [] : [];
    const at = (path: string) => (p?.line ? `${path}:${p.line}` : path);
    if (found.length === 1) return { frame, source: at(found[0]) };
    if (found.length > 1) {
      const ranked = rank(found, p!.className);
      if (p!.line) {
        const checked = await Promise.all(ranked.map((path) => confirms(idx.root, path, p!.method, p!.line!)));
        const matching = ranked.filter((_, i) => checked[i]);
        if (matching.length === 1) return { frame, source: at(matching[0]) };
        if (matching.length > 1) return { frame, candidates: matching.map(at) };
      }
      return { frame, candidates: ranked.map(at) };
    }
    return { frame };
  }));
}

export async function sourceIndexInfo(): Promise<{ root: string; files: number; truncated: boolean }> {
  const idx = await index();
  let files = 0;
  for (const list of idx.byName.values()) files += list.length;
  return { root: idx.root, files, truncated: idx.truncated };
}
