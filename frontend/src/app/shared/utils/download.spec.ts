import { resolveExportFilename } from './download';

describe('resolveExportFilename', () => {
  it('falls back to the generated filename when nothing was typed', () => {
    expect(resolveExportFilename('', 'odeysys-abc123.md', '.md')).toBe('odeysys-abc123.md');
    expect(resolveExportFilename('   ', 'odeysys-abc123.md', '.md')).toBe('odeysys-abc123.md');
  });

  it('appends the real export extension to a custom name that lacks one', () => {
    expect(resolveExportFilename('booking-investigation', 'odeysys-abc123.md', '.md')).toBe('booking-investigation.md');
  });

  it('does not duplicate the extension when the user already typed it', () => {
    expect(resolveExportFilename('booking-investigation.md', 'odeysys-abc123.md', '.md')).toBe('booking-investigation.md');
    expect(resolveExportFilename('booking-investigation.MD', 'odeysys-abc123.md', '.md')).toBe('booking-investigation.MD');
  });

  it('ignores whatever extension the user typed and uses the export’s real one instead', () => {
    // A user mistyping ".txt" must not end up with a Markdown export that lies about its own format.
    expect(resolveExportFilename('booking-investigation.txt', 'odeysys-abc123.md', '.md')).toBe('booking-investigation.txt.md');
  });

  // The bug this guards: the generated default filename routinely has its OWN dots before the real
  // extension (a supplier host like host.docker.internal becomes part of the name), so the
  // extension must come from the caller, never be parsed out of defaultFilename by splitting on
  // the first or last '.' - either would grab the wrong substring here.
  it('is unaffected by dots inside the generated default filename', () => {
    const generated = 'host.docker.internal-c_2026_09_13T17_59_28_GET_odeysysadmin_downloadPortalFile.md';
    expect(resolveExportFilename('booking-investigation', generated, '.md')).toBe('booking-investigation.md');
  });

  it('handles the compound Postman extension as one unit', () => {
    expect(
      resolveExportFilename('my-collection', 'alfred-export-4-calls.postman_collection.json', '.postman_collection.json')
    ).toBe('my-collection.postman_collection.json');
  });

  it('strips path separators and other filesystem-hostile characters', () => {
    expect(resolveExportFilename('../../etc/passwd', 'odeysys-abc123.md', '.md')).toBe('.._.._etc_passwd.md');
    expect(resolveExportFilename('weird:name?"<>|', 'odeysys-abc123.md', '.md')).toBe('weird_name_____.md');
  });

  it('trims trailing dots left after stripping, rather than exporting a hidden dotfile', () => {
    expect(resolveExportFilename('report...', 'odeysys-abc123.md', '.md')).toBe('report.md');
  });

  it('falls back to the generated filename when sanitizing leaves nothing usable', () => {
    expect(resolveExportFilename('...', 'odeysys-abc123.md', '.md')).toBe('odeysys-abc123.md');
  });
});
