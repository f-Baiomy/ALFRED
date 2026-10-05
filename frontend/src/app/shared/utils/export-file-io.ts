/**
 * Reading and writing .json exports of any size (json-export-v2.ts) - never as one giant string, which is what makes
 * a big capture work at all: a browser cannot hold a string of a gigabyte.
 *
 *  - Writing: the export's lines go into a Blob part by part; "compress" pipes that through gzip (.json.gz).
 *  - Reading: a .json or .json.gz is streamed and decoded; a version 2 file is parsed one line at a time (each line
 *    is a record), a version 1 file - one JSON document with no line structure - is parsed whole, as before.
 */

/** True for a gzip file, by its two magic bytes rather than its name. */
async function isGzip(file: Blob): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  return head.length === 2 && head[0] === 0x1f && head[1] === 0x8b;
}

/** The export's lines as a Blob ("\n" between them), gzip-compressed when asked. */
export async function exportBlob(lines: readonly string[], compress: boolean): Promise<Blob> {
  const parts: string[] = [];
  lines.forEach((line, i) => parts.push(i < lines.length - 1 ? `${line}\n` : line));
  const json = new Blob(parts, { type: 'application/json' });
  if (!compress) return json;
  const gz = json.stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(gz, { headers: { 'Content-Type': 'application/gzip' } }).blob();
}

/** Calls `onLine` for every line of the stream, without ever joining more than one line into a string. */
async function forEachLine(stream: ReadableStream<string>, onLine: (line: string) => void): Promise<void> {
  const reader = stream.getReader();
  let pending: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let chunk = value;
    let nl = chunk.indexOf('\n');
    while (nl >= 0) {
      pending.push(chunk.slice(0, nl));
      onLine(pending.join(''));
      pending = [];
      chunk = chunk.slice(nl + 1);
      nl = chunk.indexOf('\n');
    }
    if (chunk) pending.push(chunk);
  }
  if (pending.length) onLine(pending.join(''));
}

const SECTION_START = /^"([A-Za-z]+)":\[$/;

/**
 * The parsed contents of an export file - the same object JSON.parse would give for the whole file, so it goes
 * straight into parseImportedCalls. Throws SyntaxError for a file that is not JSON.
 */
export async function readExportFile(file: Blob): Promise<unknown> {
  const raw = (await isGzip(file)) ? file.stream().pipeThrough(new DecompressionStream('gzip')) : file.stream();
  const text = raw.pipeThrough(new TextDecoderStream());

  const result: Record<string, unknown> = {};
  let section: unknown[] | null = null;
  let version1: string[] | null = null;
  let first = true;
  await forEachLine(text, (rawLine) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (version1) {
      version1.push(line);
      return;
    }
    if (first) {
      first = false;
      if (!/^\{"alfredExport":[23],/.test(line)) {
        version1 = [line];
        return;
      }
    }
    if (section) {
      if (line === '],' || line === ']}' || line === ']') {
        section = null;
        return;
      }
      section.push(JSON.parse(line.endsWith(',') ? line.slice(0, -1) : line));
      return;
    }
    const start = SECTION_START.exec(line);
    if (start) {
      section = [];
      result[start[1]] = section;
      return;
    }
    // A header line: one or more "key":value pairs, the first line opening the document.
    let pairs = line.startsWith('{') ? line.slice(1) : line;
    if (pairs.endsWith(',')) pairs = pairs.slice(0, -1);
    if (pairs.trim()) Object.assign(result, JSON.parse(`{${pairs}}`));
  });
  return version1 ? JSON.parse((version1 as string[]).join('\n')) : result;
}
