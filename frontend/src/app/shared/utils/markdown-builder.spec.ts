import { CallRecord } from '../../core/models/call.model';
import { ExportFormData } from '../../core/models/export-metadata.model';
import { buildExportMarkdown, exportFilename } from './markdown-builder';

function makeCall(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    original_url: 'https://example.com-proxy/api/x',
    url: 'https://example.com/api/x',
    method: 'POST',
    request: { headers: { Accept: 'application/json' }, body: '{"supplier":"FlyNas"}' },
    timestamp: '2026-08-07T13:45:51.965328+00:00',
    duration_ms: 2965.59,
    response: { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{"ok":true}' },
    ...overrides,
  };
}

function makeForm(overrides: Partial<ExportFormData> = {}): ExportFormData {
  return {
    supplierName: 'FlyNas',
    credentialsUsed: 'EGY',
    apiKey: 'secret-key',
    url: 'https://example.com/api/x',
    environment: 'Staging',
    description: '',
    ...overrides,
  };
}

describe('buildExportMarkdown', () => {
  it('includes every metadata field', () => {
    const md = buildExportMarkdown(makeCall(), makeForm());
    expect(md).toContain('**Supplier Name:** FlyNas');
    expect(md).toContain('**Supplier Credentials Used:** EGY');
    expect(md).toContain('**Environment:** Staging');
    expect(md).toContain('**URL:** https://example.com/api/x');
    expect(md).toContain('**API Key:** secret-key');
  });

  it('shows a placeholder for blank optional fields instead of an empty value', () => {
    const md = buildExportMarkdown(makeCall(), makeForm({ description: '' }));
    expect(md).toContain('**Description:** _(none provided)_');
  });

  it('pretty-prints JSON bodies and headers in fenced code blocks', () => {
    const md = buildExportMarkdown(makeCall(), makeForm());
    expect(md).toContain('```json\n{\n  "supplier": "FlyNas"\n}\n```');
    expect(md).toContain('```json\n{\n  "ok": true\n}\n```');
    expect(md).toContain('"Accept": "application/json"');
  });

  it('never truncates the body, however large', () => {
    const bigArray = Array.from({ length: 500 }, (_, i) => ({ index: i, value: `item-${i}` }));
    const call = makeCall({ response: { status: 200, headers: {}, body: JSON.stringify(bigArray) } });
    const md = buildExportMarkdown(call, makeForm());
    expect(md).toContain('"index": 499');
    expect(md).toContain('"value": "item-499"');
    expect(md).not.toContain('...');
  });

  it('embeds non-JSON bodies verbatim instead of dropping them', () => {
    const call = makeCall({ request: { headers: {}, body: 'not json at all' } });
    const md = buildExportMarkdown(call, makeForm());
    expect(md).toContain('```\nnot json at all\n```');
  });

  it('shows the error and omits the Response Status/Headers/Body when there is no response', () => {
    const call = makeCall({ response: undefined, error: 'Client disconnected.' });
    const md = buildExportMarkdown(call, makeForm());
    expect(md).toContain('⚠️ **Error:** Client disconnected. No response was received for this call.');
    expect(md).not.toContain('**Status:**');
  });

  it('shows both the error and the response when a response did arrive alongside one', () => {
    const call = makeCall({ error: 'timeout warning' });
    const md = buildExportMarkdown(call, makeForm());
    expect(md).toContain('⚠️ **Error:** timeout warning');
    expect(md).toContain('**Status:** `200`');
  });

  it('includes duration only when present', () => {
    expect(buildExportMarkdown(makeCall({ duration_ms: 42 }), makeForm())).toContain('**Duration:** 42 ms');
    expect(buildExportMarkdown(makeCall({ duration_ms: undefined }), makeForm())).not.toContain('**Duration:**');
  });
});

describe('exportFilename', () => {
  it('derives a filesystem-safe name from the supplier hostname and call identity', () => {
    const name = exportFilename(makeCall());
    expect(name).toMatch(/^example\.com-c_.*\.md$/);
  });
});
