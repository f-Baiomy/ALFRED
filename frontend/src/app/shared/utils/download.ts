function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function downloadJson(data: unknown, filename: string): void {
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), filename);
}

export function downloadText(text: string, filename: string, mimeType = 'text/markdown'): void {
  downloadBlob(new Blob([text], { type: mimeType }), filename);
}

/**
 * What actually gets written to disk, given whatever the user typed into the export dialog's
 * optional filename field. Blank/whitespace-only input means "no opinion" - falls back to the
 * builder's own generated name (e.g. `odeysys-abc123.md`) exactly as before this field existed, so
 * the field is additive rather than something every export now has to fill in.
 *
 * `extension` is passed in explicitly (e.g. `.md`, `.postman_collection.json`) rather than parsed
 * out of `defaultFilename` - a generated name routinely contains its own dots before the real
 * extension (a supplier host like `host.docker.internal` becomes part of the filename), so finding
 * "the" extension by splitting on the first or last `.` picks the wrong substring either way.
 *
 * Path separators and other characters a filesystem would reject are stripped rather than the
 * whole name being discarded.
 */
export function resolveExportFilename(customName: string, defaultFilename: string, extension: string): string {
  const trimmed = customName.trim();
  if (trimmed.length === 0) return defaultFilename;

  const sanitized = trimmed
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\.+$/, '')
    .trim();
  if (sanitized.length === 0) return defaultFilename;

  return sanitized.toLowerCase().endsWith(extension.toLowerCase()) ? sanitized : `${sanitized}${extension}`;
}
