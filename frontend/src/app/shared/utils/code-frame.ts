/**
 * One stack frame as the db-agent records it - `com.tt.dao.GenericDAOImpl.fetchWithHQL(GenericDAOImpl.java:468)` (the
 * full class name since the agent kept the package; older captures have only `GenericDAOImpl.fetchWithHQL(...)`).
 */
export interface CodeFrame {
  /** As recorded. */
  readonly text: string;
  /** For reading: the simple class name - `GenericDAOImpl.fetchWithHQL(GenericDAOImpl.java:468)`. */
  readonly short: string;
  readonly file: string;
  readonly line: number;
  /** `com/tt/dao/GenericDAOImpl.java` - the file's place under a source folder; null when the package is unknown. */
  readonly path: string | null;
}

const FRAME = /^(.+)\.([^.(]+)\(([^():]+):(\d+)\)\s*$/;

export function parseCodeFrame(text: string | null | undefined): CodeFrame | null {
  const m = text ? FRAME.exec(text.trim()) : null;
  if (!m) return null;
  const cls = m[1];
  const file = m[3];
  const dot = cls.lastIndexOf('.');
  const pkg = dot > 0 ? cls.slice(0, dot) : '';
  // an all-lower-case first part is a package; "Outer$Inner" has none
  const hasPackage = !!pkg && /^[a-z_][\w]*(\.[a-z_][\w]*)*$/.test(pkg);
  return {
    text: text!.trim(),
    short: `${hasPackage ? cls.slice(dot + 1) : cls}.${m[2]}(${file}:${m[4]})`,
    file,
    line: Number(m[4]),
    path: hasPackage ? `${pkg.replace(/\./g, '/')}/${file}` : null,
  };
}

/** The frame for reading (simple class name); anything that is not a frame stays as it is. */
export function shortFrame(text: string | null | undefined): string {
  return parseCodeFrame(text)?.short ?? text ?? '';
}

/** IntelliJ's built-in server on THIS computer (the browser's). Its open-file API is the "IDE Remote Control" plugin. */
export const INTELLIJ_API = 'http://localhost:63342/api/file';

/**
 * What to ask IntelliJ to open: the package path (`com/tt/dao/GenericDAOImpl.java`), which IntelliJ resolves against the
 * open project's source folders by itself - no setting. A bare file name it cannot find.
 */
export function intellijUrl(frame: CodeFrame): string {
  return `${INTELLIJ_API}?file=${encodeURIComponent(frame.path ?? frame.file)}&line=${frame.line}`;
}

/** VS Code on this computer: a folder of this project's sources on this computer + the file's path under it. */
export function vscodeUrl(folder: string, frame: CodeFrame): string | null {
  if (!frame.path) return null;
  const root = folder.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const full = `${root}/${frame.path}`;
  return `vscode://file/${encodeURI(full.startsWith('/') ? full.slice(1) : full)}:${frame.line}`;
}
